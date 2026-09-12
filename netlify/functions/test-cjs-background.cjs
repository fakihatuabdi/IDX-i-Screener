// TEMPORARY A/B test: classic CommonJS background function, to check whether ESM
// (.mjs) named-export background functions are the reason run-update-background never
// actually executes on this account. Just writes one Blobs key - no pipeline logic.
const { getStore } = require("@netlify/blobs");

exports.handler = async function (event, context) {
  console.log("test-cjs-background: handler invoked");
  const store = getStore("ihsg-dashboard");
  await store.setJSON("cjs-background-test", { ok: true, at: new Date().toISOString() });
};
