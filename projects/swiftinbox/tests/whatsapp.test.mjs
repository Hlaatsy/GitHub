import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseInbound, verifyMetaSignature } from "../src/lib/whatsapp.ts";

const SECRET = "test-app-secret";
process.env.WHATSAPP_APP_SECRET = SECRET;

function sign(body) {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
}

test("a correctly signed body passes", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifyMetaSignature(body, sign(body)), true);
});

test("anything else is rejected", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifyMetaSignature(body, null), false, "missing header");
  assert.equal(verifyMetaSignature(body, "sha256=deadbeef"), false, "wrong digest");
  assert.equal(verifyMetaSignature(body, sign(body).replace("sha256=", "")), false, "no prefix");
  assert.equal(verifyMetaSignature(body + " ", sign(body)), false, "body tampered with");
  assert.equal(verifyMetaSignature(body, "sha256=zzzz"), false, "not hex");
});

test("no app secret means nothing is trusted", () => {
  // Fail closed. An empty secret would otherwise produce a valid HMAC that
  // an attacker could compute for themselves.
  const body = "{}";
  const saved = process.env.WHATSAPP_APP_SECRET;
  process.env.WHATSAPP_APP_SECRET = "";
  assert.equal(verifyMetaSignature(body, sign(body)), false);
  process.env.WHATSAPP_APP_SECRET = saved;
});

const textPayload = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "PN1" },
            contacts: [{ wa_id: "27821234567", profile: { name: "Thabo" } }],
            messages: [
              { id: "wamid.A", from: "27821234567", type: "text", text: { body: "Is the shop open?" } },
            ],
          },
        },
      ],
    },
  ],
};

test("a text message is picked up with its business and sender", () => {
  const [m] = parseInbound(textPayload);
  assert.equal(m.phoneNumberId, "PN1");
  assert.equal(m.waId, "27821234567");
  assert.equal(m.contactName, "Thabo");
  assert.equal(m.messageId, "wamid.A");
  assert.equal(m.text, "Is the shop open?");
});

test("delivery and read receipts are not messages", () => {
  // These arrive constantly. Treating one as a message would open a
  // conversation and charge the client for their own outgoing reply.
  const statuses = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "PN1" },
              statuses: [{ id: "wamid.A", status: "delivered" }],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(parseInbound(statuses), []);
});

test("media we cannot answer is not charged as a conversation", () => {
  const image = structuredClone(textPayload);
  image.entry[0].changes[0].value.messages[0] = {
    id: "wamid.B",
    from: "27821234567",
    type: "image",
    image: { id: "media-1" },
  };
  assert.deepEqual(parseInbound(image), []);
});

test("junk does not throw", () => {
  for (const junk of [null, undefined, {}, { object: "page" }, { object: "whatsapp_business_account" }]) {
    assert.deepEqual(parseInbound(junk), []);
  }
});

test("a message with no phone_number_id is dropped rather than guessed at", () => {
  const orphan = structuredClone(textPayload);
  delete orphan.entry[0].changes[0].value.metadata;
  assert.deepEqual(parseInbound(orphan), []);
});
