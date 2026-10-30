// Claim: a room slot is booked at most once.
//
// Asks for the same room slot twice, once on each copy, sending each request
// straight to the copy with a token that copy issued. Through the proxy,
// Finding 1 gets in the way: about half the requests would come back 401 from
// the copy that never issued the token, and a 401 says nothing about the slot.
//
//   docker compose run --rm --no-deps \
//     -e COPY_A=http://<name>:8080 -e TOKEN_A=<that copy's u-1 token> \
//     -e COPY_B=http://<name>:8080 -e TOKEN_B=<that copy's u-2 token> \
//     k6 run /load/bookings.js
//
// The two requests come from two accounts (u-1 on A, u-2 on B), so that on a
// single copy the second one meets the room's calendar rather than the
// asker's own (which would be USER_DOUBLE_BOOKED instead of a waitlisting).
//
// Passes only if the slot is confirmed exactly once (slot_confirmed count==1):
// twice breaks the claim, and never means the run could not book at all.
// Every answer has to be 201 confirmed or 202 waitlisted
// (unexpected_status rate==0). setup() picks a slot that both copies show as
// free, and stops the run when A and B are the same copy (B's token has to be
// refused by A) unless MIN_COPIES=1.
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';

const COPY_A = __ENV.COPY_A;
const COPY_B = __ENV.COPY_B;
const TOKEN_A = __ENV.TOKEN_A;
const TOKEN_B = __ENV.TOKEN_B;
const MIN_COPIES = Number(__ENV.MIN_COPIES || 2);
const ROOM = __ENV.ROOM || 'r-1';
const MINUTES = 60;

const confirmed = new Counter('slot_confirmed');
const unexpected = new Rate('unexpected_status');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    slot_confirmed: ['count==1'],
    unexpected_status: ['rate==0'],
  },
};

function bookingsStatus(base, token) {
  return http.get(`${base}/bookings`, { headers: { Authorization: `Bearer ${token}` } }).status;
}

function slotStarts(base, date) {
  const res = http.get(`${base}/rooms/${ROOM}/availability?date=${date}&minutes=${MINUTES}`);
  return res.status === 200 ? res.json('slots').map((slot) => slot.start) : [];
}

export function setup() {
  if (!COPY_A || !COPY_B || !TOKEN_A || !TOKEN_B) {
    exec.test.abort('Set COPY_A, TOKEN_A, COPY_B, and TOKEN_B.');
  }
  if (bookingsStatus(COPY_A, TOKEN_A) !== 200 || bookingsStatus(COPY_B, TOKEN_B) !== 200) {
    exec.test.abort('Each token has to be one its own copy issued.');
  }
  if (MIN_COPIES >= 2 && bookingsStatus(COPY_A, TOKEN_B) !== 401) {
    exec.test.abort('A accepted B\'s token, so A and B look like the same copy.');
  }

  for (let days = 1; days <= 7; days++) {
    const date = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const freeOnB = new Set(slotStarts(COPY_B, date));
    const start = slotStarts(COPY_A, date).find((candidate) => freeOnB.has(candidate));
    if (start) {
      console.log(`slot: ${ROOM} from ${start} for ${MINUTES} minutes`);
      return { start };
    }
  }
  exec.test.abort('No slot in the next week is free on both copies.');
}

export default function ({ start }) {
  const asks = [
    ['A', COPY_A, TOKEN_A],
    ['B', COPY_B, TOKEN_B],
  ];
  for (const [name, base, token] of asks) {
    const res = http.post(
      `${base}/bookings`,
      { roomId: ROOM, start, minutes: String(MINUTES) },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const outcome = { 201: 'confirmed', 202: 'waitlisted' }[res.status];
    console.log(`copy ${name} (${base}): ${res.status} ${outcome || res.body}`);
    confirmed.add(res.status === 201 ? 1 : 0);
    unexpected.add(!outcome);
  }
}
