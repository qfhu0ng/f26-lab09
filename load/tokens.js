// Claim: a token works on any request, whichever copy answers it.
//
// Sends GET /bookings through the proxy with one bearer token and checks that
// every answer is a 200. Take TOKEN from the u-1 line of any copy in
// `docker compose logs api`:
//
//   docker compose run --rm --no-deps -e TOKEN=... k6 run /load/tokens.js
//
// Passes only if every request is accepted (token_accepted rate==1). setup()
// stops the run unless MIN_COPIES copies (default 2) answer through the proxy,
// so a pass cannot come from a stack that only reached one copy.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://proxy';
const TOKEN = __ENV.TOKEN;
const MIN_COPIES = Number(__ENV.MIN_COPIES || 2);
const REQUESTS = 40;

const accepted = new Rate('token_accepted');

export const options = {
  vus: 1,
  iterations: REQUESTS,
  thresholds: {
    token_accepted: ['rate==1'],
  },
};

export function setup() {
  if (!TOKEN) {
    exec.test.abort('Set TOKEN to a token that one copy printed at startup.');
  }
  const copies = new Set();
  for (let i = 0; i < 20; i++) {
    const copy = http.get(`${BASE}/health`).headers['X-Upstream'];
    if (copy) {
      copies.add(copy);
    }
  }
  if (copies.size < MIN_COPIES) {
    exec.test.abort(`${copies.size} copy answered through the proxy, wanted ${MIN_COPIES}.`);
  }
  console.log(`copies answering: ${[...copies].join(', ')}`);
}

// Status codes seen per copy. One VU runs every iteration, so this is the
// whole run's tally by the last one.
const statusesByCopy = {};

export default function () {
  const res = http.get(`${BASE}/bookings`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const copy = res.headers['X-Upstream'] || 'none';
  const ok = check(res, { 'token accepted (200)': (r) => r.status === 200 });
  accepted.add(ok, { copy });

  const statuses = (statusesByCopy[copy] = statusesByCopy[copy] || {});
  statuses[res.status] = (statuses[res.status] || 0) + 1;
  if (exec.scenario.iterationInTest === REQUESTS - 1) {
    for (const [answeredBy, counts] of Object.entries(statusesByCopy)) {
      console.log(`${answeredBy}: ${JSON.stringify(counts)}`);
    }
  }
}
