import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEPLOYMENTS_DIR = path.resolve(__dirname, "..", "deployments");
const FRONTEND_ABIS_DIR = path.resolve(__dirname, "..", "..", "..", "tic-tac-react", "src", "v2", "ABIs");
const FILES_TO_SYNC = [
    "TicTacChainFactory-ABI.json",
    "ConnectFourFactory-ABI.json",
    "ChessOnChainFactory-ABI.json",
    "ETour-Factory-ABIs.json",
    "localhost-tictac-factory.json",
    "localhost-connectfour-factory.json",
    "localhost-chess-factory.json",
];

function ensureDirExists(dirPath, label) {
    if (!fs.existsSync(dirPath)) {
        throw new Error(`${label} not found at ${dirPath}`);
    }
}

function main() {
    ensureDirExists(DEPLOYMENTS_DIR, "Deployments directory");
    ensureDirExists(FRONTEND_ABIS_DIR, "Frontend ABI directory");

    let copied = 0;
    let skipped = 0;

    for (const fileName of FILES_TO_SYNC) {
        const sourcePath = path.join(DEPLOYMENTS_DIR, fileName);
        const destPath = path.join(FRONTEND_ABIS_DIR, fileName);

        if (!fs.existsSync(sourcePath)) {
            console.log(`Skipping missing file: ${fileName}`);
            skipped += 1;
            continue;
        }

        fs.copyFileSync(sourcePath, destPath);
        console.log(`Copied ${fileName}`);
        copied += 1;
    }

    console.log("");
    console.log(`V2 ABI sync complete: ${copied} copied, ${skipped} skipped.`);
}

main();
