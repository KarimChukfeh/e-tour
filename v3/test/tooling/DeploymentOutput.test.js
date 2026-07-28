import fs from "fs";
import os from "os";
import path from "path";
import { expect } from "chai";
import {
    assertDeploymentTarget,
    atomicWriteJson,
    canonicalManifestPath,
    networkDeploymentDirectory,
    requireReviewedSourceState,
} from "../../scripts/lib/deployment-output.js";

describe("deployment output safety", function () {
    let temporaryDirectory;
    let previousDirtyOverride;

    beforeEach(function () {
        temporaryDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), "etour-v3-output-")
        );
        previousDirtyOverride =
            process.env.ALLOW_DIRTY_DEPLOYMENT;
        delete process.env.ALLOW_DIRTY_DEPLOYMENT;
    });

    afterEach(function () {
        fs.rmSync(temporaryDirectory, {
            recursive: true,
            force: true,
        });
        if (previousDirtyOverride === undefined) {
            delete process.env.ALLOW_DIRTY_DEPLOYMENT;
        } else {
            process.env.ALLOW_DIRTY_DEPLOYMENT =
                previousDirtyOverride;
        }
    });

    it("isolates canonical manifests by network", function () {
        const localhost = canonicalManifestPath(
            temporaryDirectory,
            "localhost"
        );
        const arbitrumLocal = canonicalManifestPath(
            temporaryDirectory,
            "arbitrumLocal"
        );

        expect(localhost).to.not.equal(arbitrumLocal);
        expect(localhost).to.equal(
            path.join(
                temporaryDirectory,
                "localhost",
                "manifest.json"
            )
        );
        expect(arbitrumLocal).to.equal(
            path.join(
                temporaryDirectory,
                "arbitrumLocal",
                "manifest.json"
            )
        );
    });

    it("rejects path traversal and chain ID mismatches", function () {
        expect(() =>
            networkDeploymentDirectory(
                temporaryDirectory,
                "../arbitrum"
            )
        ).to.throw("invalid network output name");
        expect(() =>
            assertDeploymentTarget(
                "arbitrumLocal",
                412346n
            )
        ).to.throw("must use chain ID 42161");
    });

    it("atomically replaces JSON without leaving a temporary file", function () {
        const output = path.join(
            temporaryDirectory,
            "localhost",
            "manifest.json"
        );
        atomicWriteJson(output, { generation: 1 });
        atomicWriteJson(output, { generation: 2 });

        expect(
            JSON.parse(fs.readFileSync(output, "utf8"))
        ).to.deep.equal({ generation: 2 });
        expect(
            fs
                .readdirSync(path.dirname(output))
                .filter((name) => name.endsWith(".tmp"))
        ).to.deep.equal([]);
    });

    it("blocks dirty public deployments but permits local work", function () {
        const repository = {
            commit: "a".repeat(40),
            dirty: true,
        };

        expect(() =>
            requireReviewedSourceState(
                "arbitrum",
                repository
            )
        ).to.throw("dirty source tree");
        expect(() =>
            requireReviewedSourceState(
                "localhost",
                repository
            )
        ).to.not.throw();
        expect(() =>
            requireReviewedSourceState(
                "arbitrumLocal",
                repository
            )
        ).to.not.throw();
    });
});
