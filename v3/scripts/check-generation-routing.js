import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const routing = JSON.parse(
    fs.readFileSync(
        path.join(root, "config", "generation-routing.json"),
        "utf8"
    )
);
const release = JSON.parse(
    fs.readFileSync(
        path.join(root, "config", "release-status.json"),
        "utf8"
    )
);

assert(routing.schemaVersion === 1, "unsupported routing schema");
assert(["v2", "v3"].includes(routing.defaultCreationGeneration), "invalid default generation");
assert(routing.readEnabled?.v2 === true, "V2 history reads must remain enabled");
assert(routing.readEnabled?.v3 === true, "V3 reads must remain enabled");
assert(routing.activeGameplayEnabled?.v2 === true, "active V2 games must remain playable");
assert(routing.activeGameplayEnabled?.v3 === true, "V3 gameplay must remain readable/playable");
assert(routing.rollbackRule, "rollback rule is missing");

if (routing.defaultCreationGeneration === "v3") {
    assert(release.cutover.status === "approved", "V3 routing requires explicit cutover approval");
    assert(release.production.canaryStatus === "approved", "V3 routing requires an approved canary");
    assert(release.production.allContractsVerified === true, "V3 routing requires verified contracts");
    assert(routing.creationEnabled.v3 === true, "V3 creation is disabled");
    assert(routing.creationEnabled.v2 === false, "V2 creation must be hidden after cutover");
} else {
    assert(release.cutover.status !== "approved", "approved cutover disagrees with V2 default");
    assert(routing.creationEnabled.v2 === true, "V2 remains the safe pre-cutover creation route");
    assert(routing.creationEnabled.v3 === false, "unapproved V3 production creation must remain disabled");
}

console.log(
    `Generation routing valid: new creation=${routing.defaultCreationGeneration}; ` +
        "V2 and V3 reads/gameplay retained; rollback is creation-only."
);

function assert(condition, message) {
    if (!condition) throw new Error(`Generation routing check failed: ${message}`);
}
