import {
    adapters,
    installCreationLifecycleSection,
    installNormalResolutionSection,
    installTimeoutSection,
    installForceEliminationSection,
    installReplacementSection,
    installEnrollmentSection,
    installDrawSection,
    installPrizeRedistributionSection,
    installPlayerRecordEdgeCasesSection,
} from "./helpers/protocolSuite.js";

describe("TicTacToe — V2 protocol parity", function () {
    this.timeout(120_000);

    const adapter = adapters.tictactoe;

    installCreationLifecycleSection(adapter);
    installNormalResolutionSection(adapter);
    installTimeoutSection(adapter);
    installForceEliminationSection(adapter);
    installReplacementSection(adapter);
    installEnrollmentSection(adapter);
    installDrawSection(adapter);
    installPrizeRedistributionSection(adapter);
    installPlayerRecordEdgeCasesSection(adapter);
});
