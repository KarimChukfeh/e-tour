// Backward-compatible entry point for the canonical all-factory deployment.
// Keeping one implementation prevents the shared PlayerRegistry and
// SessionKeyRegistry wiring from drifting between deployment commands.
import "./deploy-all-factory.js";
