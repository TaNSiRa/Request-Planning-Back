// Unit tests for the security guards that have no database behind them:
// audit redaction, the password policy, and the attachment type whitelist.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { redactSensitive } = require("../src/middleware/audit");
const { passwordPolicyProblem } = require("../src/services/passwordPolicy");
const { assertAllowedAttachment } = require("../src/services/attachmentStorage");

describe("audit redaction", () => {
  it("strips every flavour of secret out of a request body", () => {
    const body = {
      email: "someone@example.com",
      password: "hunter2",
      newPassword: "hunter3",
      currentPassword: "hunter1",
      idToken: "eyJhbGciOi...",
      clientSecret: "shhh",
      nested: { userPassword: "nope", keep: "visible" }
    };
    const out = redactSensitive(body);

    assert.equal(out.email, "someone@example.com", "harmless fields survive");
    assert.equal(out.nested.keep, "visible", "nested harmless fields survive");
    for (const key of ["password", "newPassword", "currentPassword", "idToken", "clientSecret"]) {
      assert.equal(out[key], "[REDACTED]", `${key} must not reach audit_logs`);
    }
    assert.equal(out.nested.userPassword, "[REDACTED]", "nested secrets are caught too");
  });

  it("redacts inside arrays and does not mutate the caller's object", () => {
    const body = { users: [{ name: "a", password: "p1" }, { name: "b", password: "p2" }] };
    const out = redactSensitive(body);

    assert.deepEqual(out.users.map(u => u.password), ["[REDACTED]", "[REDACTED]"]);
    assert.deepEqual(out.users.map(u => u.name), ["a", "b"]);
    assert.equal(body.users[0].password, "p1", "the original body is left alone");
  });

  it("truncates megabyte data URLs instead of storing them whole", () => {
    const dataUrl = `data:application/pdf;base64,${"A".repeat(50000)}`;
    const out = redactSensitive({ attachments: [{ dataUrl }] });
    assert.ok(out.attachments[0].dataUrl.length < 2200, "long strings are cut down");
    assert.ok(out.attachments[0].dataUrl.includes("truncated"), "and say so");
  });
});

describe("password policy", () => {
  it("accepts a reasonable password", () => {
    assert.equal(passwordPolicyProblem("Rap2026pass"), null);
    assert.equal(passwordPolicyProblem("t3stpass"), null, "exactly the minimum length is fine");
  });

  it("rejects short, letter-only, digit-only and padded passwords", () => {
    assert.ok(passwordPolicyProblem("a1"), "too short");
    assert.ok(passwordPolicyProblem("1"), "the old min(1) case");
    assert.ok(passwordPolicyProblem("passwordonly"), "no digit");
    assert.ok(passwordPolicyProblem("1234567890"), "no letter");
    assert.ok(passwordPolicyProblem(" pass1234 "), "surrounding spaces");
    assert.ok(passwordPolicyProblem(""), "empty");
    assert.ok(passwordPolicyProblem(null), "missing");
  });

  it("rejects the obvious guesses even when they pass the mechanical rules", () => {
    assert.ok(passwordPolicyProblem("Password1"));
    assert.ok(passwordPolicyProblem("admin123"));
  });
});

describe("attachment whitelist", () => {
  it("accepts the allowed office and image types", () => {
    assert.doesNotThrow(() => assertAllowedAttachment("spec.pdf", "application/pdf"));
    assert.doesNotThrow(() => assertAllowedAttachment("photo.JPG", "image/jpeg"));
    assert.doesNotThrow(() => assertAllowedAttachment(
      "plan.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  });

  it("tolerates a browser that reports no useful content type", () => {
    assert.doesNotThrow(() => assertAllowedAttachment("report.docx", ""));
    assert.doesNotThrow(() => assertAllowedAttachment("report.docx", "application/octet-stream"));
  });

  it("rejects executables, scripts and unknown extensions", () => {
    for (const name of ["payload.exe", "shell.aspx", "run.bat", "notes.txt", "archive.zip", "noextension"]) {
      assert.throws(() => assertAllowedAttachment(name, "application/octet-stream"), /not allowed/i, name);
    }
  });

  it("rejects a file whose declared type contradicts its extension", () => {
    assert.throws(
      () => assertAllowedAttachment("invoice.pdf", "text/html"),
      /does not match its type/i
    );
  });

  it("gives a 400, not a 500, so the user sees the reason", () => {
    try {
      assertAllowedAttachment("payload.exe", "application/octet-stream");
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.status, 400);
    }
  });
});
