const assert = require("assert");
const fs = require("fs");
const path = require("path");

const firebaseConfigurationPath = path.resolve(__dirname, "../../firebase.json");
const firebaseConfiguration = JSON.parse(fs.readFileSync(firebaseConfigurationPath, "utf8"));
const rulesPath = path.resolve(__dirname, "../../firestore.rules");
const rules = fs.readFileSync(rulesPath, "utf8");

assert.deepStrictEqual(firebaseConfiguration.firestore, {
    database: "(default)",
    indexes: "firestore.index.json",
    rules: "firestore.rules"
});
assert.ok(rules.includes("function userDataWriteAllowed(userId)"));
assert.ok(rules.includes("documents/authCredentials/$(userId)"));
assert.ok(rules.includes("data.deletionStartedAt == null"));
assert.ok(rules.includes("userDataWriteAllowed(userId)"));
assert.ok(rules.includes("match /{collectionId}/{document=**} {"));
assert.ok(rules.includes("collectionId != 'developmentGoals'"));
assert.ok(!rules.includes("match /{document=**} {"));
assert.ok(rules.includes("match /developmentGoals/{goalId} {"));
assert.ok(rules.includes("request.resource.data.get('status', null) != 'completed'"));
assert.ok(rules.includes("match /records/{recordId} {"));

const versionBlock = rules.match(/match \/versions\/\{versionId\} \{[\s\S]*?\n\s*\}/)[0];

assert.ok(versionBlock.includes("allow create:"));
assert.ok(!/\b(update|delete|write)\b/.test(versionBlock));
