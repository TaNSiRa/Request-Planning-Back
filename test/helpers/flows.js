// Reusable API-level building blocks shared by the test files. Every helper
// asserts the HTTP status so a failure points at the step that broke, not at
// a later assertion working on bad data.
const assert = require("node:assert/strict");

// One valid create-request payload; tests tweak copies as needed.
function requestPayload(overrides = {}) {
  return {
    title: "API test request",
    requestType: "IMPROVEMENT",
    systemArea: "Test area",
    priority: "NORMAL",
    dueDate: "2026-12-31",
    description: "created by automated test",
    businessImpact: "none",
    attachments: [],
    ...overrides
  };
}

async function createRequest(session, overrides = {}) {
  const res = await session.post("/api/requests").send(requestPayload(overrides));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body; // { id, requestNo }
}

async function getRequest(session, id) {
  const res = await session.get(`/api/requests/${id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

// The approval step the user currently sees in their pending inbox for a
// request (covers both request approvals and close approvals).
async function pendingStepFor(session, requestId) {
  const res = await session.get("/api/approvals/pending");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.find(row => row.request_id === requestId) || null;
}

// The pending schedule-extension row the user sees for a request.
async function pendingExtensionFor(session, requestId) {
  const res = await session.get("/api/approvals/extensions/pending");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.find(row => row.request_id === requestId) || null;
}

// Default assigned project period used across the tests.
const PROJECT_START = "2026-08-03";
const PROJECT_END = "2026-08-21";

const assignPayload = (inchargeUserId, overrides = {}) => ({
  inchargeUserId,
  plannedStart: PROJECT_START,
  plannedEnd: PROJECT_END,
  supTypes: [],
  ...overrides
});

// Create a request and push it through the whole 2-step fixture route so it
// lands IN_PROGRESS with `inchargeUserId` assigned. Returns the request id.
async function approveToInProgress({ requester, approver1, approver2, inchargeUserId }) {
  const { id } = await createRequest(requester);
  const step1 = await pendingStepFor(approver1, id);
  assert.ok(step1, "step 1 should be pending for approver 1");
  const res1 = await approver1.post(`/api/approvals/${step1.id}/approve`).send(assignPayload(inchargeUserId));
  assert.equal(res1.status, 200, JSON.stringify(res1.body));
  const step2 = await pendingStepFor(approver2, id);
  assert.ok(step2, "step 2 should be pending for approver 2");
  const res2 = await approver2.post(`/api/approvals/${step2.id}/approve`).send({});
  assert.equal(res2.status, 200, JSON.stringify(res2.body));
  return id;
}

module.exports = {
  PROJECT_START,
  PROJECT_END,
  approveToInProgress,
  assignPayload,
  createRequest,
  getRequest,
  pendingExtensionFor,
  pendingStepFor,
  requestPayload
};
