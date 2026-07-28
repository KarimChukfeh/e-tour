import {
    generateBrowserSessionKey,
    generateSessionSalt,
} from "../sdk/dist/index.js";

const key = generateBrowserSessionKey();
try {
    console.log(
        JSON.stringify(
            {
                developmentOnly: true,
                owner: key.address,
                salt: generateSessionSalt().toString(),
                warning:
                    "The private key was not printed or persisted; this identity is intentionally ephemeral.",
            },
            null,
            2
        )
    );
} finally {
    key.destroy();
}
