// Run through `compose exec -T backend node - < this-file`. Credentials stay in
// memory, never in the log, command arguments or node identity volumes.
const assert = require("node:assert/strict");
const { getPgPool } = require(`${process.cwd()}/db`);
const { mintCredential } = require(
  `${process.cwd()}/services/NodeCredentialService`,
);

const [source, destination, state] = process.argv.slice(2);
assert.ok(
  source && destination && ["allowed", "blocked"].includes(state),
  "invalid probe arguments",
);
const pool = getPgPool();

(async () => {
  let minted;
  try {
    minted = await mintCredential(source, 1);
    const response = await fetch(
      `http://127.0.0.1:${process.env.PORT || 8081}/v4/control/discover`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ explicit_host_id: destination }),
        signal: AbortSignal.timeout(10000),
      },
    );
    assert.equal(
      response.status,
      200,
      "discovery did not accept the real node credential",
    );
    const { bridges } = await response.json();
    assert.deepEqual(
      bridges.map((bridge) => bridge.node_id),
      state === "allowed" ? [destination] : [],
      "discovery disagrees with the permitted TCP pair",
    );
    console.log(
      `authenticated discovery ${source} -> ${destination}: ${state}`,
    );
  } finally {
    if (minted)
      await pool.query("DELETE FROM node_credentials WHERE id = $1", [
        minted.credentialId,
      ]);
    await pool.end();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
