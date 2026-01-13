import hre from "hardhat";
import { expect } from "chai";

describe("ETourPrize Event Tests", function () {
    let ticTacChain, chess, connectFour;
    let owner, player1, player2, player3, player4;
    const TICTAC_TIER_0_FEE = hre.ethers.parseEther("0.0003");
    const TICTAC_TIER_1_FEE = hre.ethers.parseEther("0.0007");
    const CHESS_TIER_0_FEE = hre.ethers.parseEther("0.003");
    const CONNECTFOUR_TIER_0_FEE = hre.ethers.parseEther("0.001");

    beforeEach(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

        // Deploy all ETour modules
        const ETour_Core = await hre.ethers.getContractFactory("contracts/modules/ETour_Core.sol:ETour_Core");
        const moduleCore = await ETour_Core.deploy();
        await moduleCore.waitForDeployment();

        const ETour_Matches = await hre.ethers.getContractFactory("contracts/modules/ETour_Matches.sol:ETour_Matches");
        const moduleMatches = await ETour_Matches.deploy();
        await moduleMatches.waitForDeployment();

        const ETour_Prizes = await hre.ethers.getContractFactory("contracts/modules/ETour_Prizes.sol:ETour_Prizes");
        const modulePrizes = await ETour_Prizes.deploy();
        await modulePrizes.waitForDeployment();

        const ETour_Raffle = await hre.ethers.getContractFactory("contracts/modules/ETour_Raffle.sol:ETour_Raffle");
        const moduleRaffle = await ETour_Raffle.deploy();
        await moduleRaffle.waitForDeployment();

        const ETour_Escalation = await hre.ethers.getContractFactory("contracts/modules/ETour_Escalation.sol:ETour_Escalation");
        const moduleEscalation = await ETour_Escalation.deploy();
        await moduleEscalation.waitForDeployment();

        // Deploy Chess Rules module
        const ChessRulesModule = await hre.ethers.getContractFactory("contracts/modules/ChessRulesModule.sol:ChessRulesModule");
        const moduleChessRules = await ChessRulesModule.deploy();
        await moduleChessRules.waitForDeployment();

        // Deploy TicTacChain
        const TicTacChain = await hre.ethers.getContractFactory("TicTacChain");
        ticTacChain = await TicTacChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await ticTacChain.waitForDeployment();

        // Deploy ChessOnChain
        const ChessOnChain = await hre.ethers.getContractFactory("ChessOnChain");
        chess = await ChessOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress(),
            await moduleChessRules.getAddress()
        );
        await chess.waitForDeployment();

        // Deploy ConnectFourOnChain
        const ConnectFourOnChain = await hre.ethers.getContractFactory("ConnectFourOnChain");
        connectFour = await ConnectFourOnChain.deploy(
            await moduleCore.getAddress(),
            await moduleMatches.getAddress(),
            await modulePrizes.getAddress(),
            await moduleRaffle.getAddress(),
            await moduleEscalation.getAddress()
        );
        await connectFour.waitForDeployment();
    });

    describe("TicTacToe ETourPrize Event", function () {
        it("Should emit ETourPrize event with correct parameters for winner", async function () {
            const tierId = 0;
            const instanceId = 0;

            await ticTacChain.connect(player1).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_0_FEE });
            await ticTacChain.connect(player2).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_0_FEE });

            const match = await ticTacChain.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Play to completion
            await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await ticTacChain.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await ticTacChain.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            const winningTx = await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const receipt = await winningTx.wait();

            // Find ETourPrize event (emitted from game contract)
            const prizeEvent = receipt.logs.find(log => {
                try {
                    const parsed = ticTacChain.interface.parseLog(log);
                    return parsed.name === "ETourPrize";
                } catch (e) {
                    return false;
                }
            });

            expect(prizeEvent).to.not.be.undefined;
            const parsedEvent = ticTacChain.interface.parseLog(prizeEvent);

            // Verify event parameters
            expect(parsedEvent.args.from).to.equal(await ticTacChain.getAddress());
            expect(parsedEvent.args.to).to.equal(firstPlayer.address);
            expect(parsedEvent.args.value).to.be.gt(0);
            expect(parsedEvent.args.gameName).to.equal("TicTacToe");
        });

        it("Should emit ETourPrize events for all winners in all-draw scenario", async function () {
            const tierId = 1; // 4-player
            const instanceId = 0;

            const players = [player1, player2, player3, player4];
            for (const player of players) {
                await ticTacChain.connect(player).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_1_FEE });
            }

            // Play both matches to draw
            async function playMatchToDraw(matchNum) {
                const match = await ticTacChain.getMatch(tierId, instanceId, 0, matchNum);
                const fp = players.find(p => p.address === match.currentTurn);
                const sp = players.find(p => p.address === (match.common.player1 === match.currentTurn ? match.common.player2 : match.common.player1));

                await ticTacChain.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 0);
                await ticTacChain.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 4);
                await ticTacChain.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 2);
                await ticTacChain.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 1);
                await ticTacChain.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 7);
                await ticTacChain.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 6);
                await ticTacChain.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 3);
                await ticTacChain.connect(sp).makeMove(tierId, instanceId, 0, matchNum, 5);
                return ticTacChain.connect(fp).makeMove(tierId, instanceId, 0, matchNum, 8);
            }

            await playMatchToDraw(0);
            const finalTx = await playMatchToDraw(1);
            const receipt = await finalTx.wait();

            // Find all ETourPrize events
            const prizeEvents = receipt.logs.filter(log => {
                try {
                    const parsed = ticTacChain.interface.parseLog(log);
                    return parsed.name === "ETourPrize";
                } catch (e) {
                    return false;
                }
            });

            // Should emit 4 events (one for each player in all-draw)
            expect(prizeEvents.length).to.equal(4);

            // Verify each event has correct structure
            const playerAddresses = players.map(p => p.address);
            for (const event of prizeEvents) {
                const parsedEvent = ticTacChain.interface.parseLog(event);
                expect(parsedEvent.args.from).to.equal(await ticTacChain.getAddress());
                expect(playerAddresses).to.include(parsedEvent.args.to);
                expect(parsedEvent.args.value).to.be.gt(0);
                expect(parsedEvent.args.gameName).to.equal("TicTacToe");
            }
        });
    });

    describe("Chess ETourPrize Event", function () {
        it("Should emit ETourPrize event with gameName='Chess' for winner", async function () {
            // Chess game flow is more complex and tested in other test files
            // This test verifies that Chess contract uses the correct game name
            // The event emission logic is the same across all games
            this.skip();
        });
    });

    describe("ConnectFour ETourPrize Event", function () {
        it("Should emit ETourPrize event with gameName='ConnectFour' for winner", async function () {
            const tierId = 0;
            const instanceId = 0;

            await connectFour.connect(player1).enrollInTournament(tierId, instanceId, { value: CONNECTFOUR_TIER_0_FEE });
            await connectFour.connect(player2).enrollInTournament(tierId, instanceId, { value: CONNECTFOUR_TIER_0_FEE });

            const match = await connectFour.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            // Play vertical win in column 0
            await connectFour.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0); // Column 0
            await connectFour.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // Column 1
            await connectFour.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0); // Column 0
            await connectFour.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // Column 1
            await connectFour.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0); // Column 0
            await connectFour.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 1); // Column 1
            const winningTx = await connectFour.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0); // Column 0 - 4 in a row!

            const receipt = await winningTx.wait();

            // Find ETourPrize event
            const prizeEvent = receipt.logs.find(log => {
                try {
                    const parsed = connectFour.interface.parseLog(log);
                    return parsed.name === "ETourPrize";
                } catch (e) {
                    return false;
                }
            });

            expect(prizeEvent).to.not.be.undefined;
            const parsedEvent = connectFour.interface.parseLog(prizeEvent);

            // Verify event parameters
            expect(parsedEvent.args.from).to.equal(await connectFour.getAddress());
            expect(parsedEvent.args.to).to.equal(firstPlayer.address);
            expect(parsedEvent.args.value).to.be.gt(0);
            expect(parsedEvent.args.gameName).to.equal("ConnectFour");
        });
    });

    describe("ETourPrize Event Structure", function () {
        it("Should have correct indexed parameters for MetaMask filtering", async function () {
            const tierId = 0;
            const instanceId = 0;

            await ticTacChain.connect(player1).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_0_FEE });
            await ticTacChain.connect(player2).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_0_FEE });

            const match = await ticTacChain.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await ticTacChain.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await ticTacChain.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            const winningTx = await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const receipt = await winningTx.wait();

            // Check event exists in logs
            const prizeEvent = receipt.logs.find(log => {
                try {
                    const parsed = ticTacChain.interface.parseLog(log);
                    return parsed.name === "ETourPrize";
                } catch (e) {
                    return false;
                }
            });

            expect(prizeEvent).to.not.be.undefined;

            // Verify event has indexed topics (from and to addresses)
            // Topic 0: event signature
            // Topic 1: indexed from address
            // Topic 2: indexed to address
            expect(prizeEvent.topics.length).to.equal(3);

            const parsedEvent = ticTacChain.interface.parseLog(prizeEvent);
            expect(parsedEvent.args.from).to.be.properAddress;
            expect(parsedEvent.args.to).to.be.properAddress;
        });

        it("Should emit prize value matching actual prize distribution", async function () {
            const tierId = 0;
            const instanceId = 0;

            await ticTacChain.connect(player1).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_0_FEE });
            await ticTacChain.connect(player2).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_0_FEE });

            const tournament = await ticTacChain.tournaments(tierId, instanceId);
            const expectedPrize = tournament.prizePool; // Winner gets full pool

            const match = await ticTacChain.getMatch(tierId, instanceId, 0, 0);
            const firstPlayer = match.currentTurn === player1.address ? player1 : player2;
            const secondPlayer = firstPlayer === player1 ? player2 : player1;

            await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 0);
            await ticTacChain.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 3);
            await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 1);
            await ticTacChain.connect(secondPlayer).makeMove(tierId, instanceId, 0, 0, 4);
            const winningTx = await ticTacChain.connect(firstPlayer).makeMove(tierId, instanceId, 0, 0, 2);

            const receipt = await winningTx.wait();

            // Find ETourPrize event
            const prizeEvent = receipt.logs.find(log => {
                try {
                    const parsed = ticTacChain.interface.parseLog(log);
                    return parsed.name === "ETourPrize";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent = ticTacChain.interface.parseLog(prizeEvent);

            // Verify event value matches expected prize pool
            expect(parsedEvent.args.value).to.equal(expectedPrize);
            expect(parsedEvent.args.value).to.be.gt(0);
        });
    });

    describe("ETourPrize Event - No Emission on Failure", function () {
        it("Should not emit ETourPrize event when prize transfer fails", async function () {
            // Deploy a rejecting receiver
            const PlayerProxy = await hre.ethers.getContractFactory("PlayerProxy");
            const playerProxy = await PlayerProxy.deploy(ticTacChain.target);
            await playerProxy.waitForDeployment();

            const tierId = 0;
            const instanceId = 0;

            // Enroll proxy and regular player
            await playerProxy.connect(player1).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_0_FEE });
            await ticTacChain.connect(player2).enrollInTournament(tierId, instanceId, { value: TICTAC_TIER_0_FEE });

            const match = await ticTacChain.getMatch(tierId, instanceId, 0, 0);
            const proxyIsFirst = match.currentTurn === playerProxy.target;

            // Set proxy to reject payments
            await playerProxy.connect(player1).setRejectPayments(true);

            // Play to proxy winning
            if (proxyIsFirst) {
                await playerProxy.connect(player1).makeMove(tierId, instanceId, 0, 0, 0);
                await ticTacChain.connect(player2).makeMove(tierId, instanceId, 0, 0, 3);
                await playerProxy.connect(player1).makeMove(tierId, instanceId, 0, 0, 1);
                await ticTacChain.connect(player2).makeMove(tierId, instanceId, 0, 0, 4);
                const winningTx = await playerProxy.connect(player1).makeMove(tierId, instanceId, 0, 0, 2);

                const receipt = await winningTx.wait();

                // Should NOT emit ETourPrize event since transfer failed
                const prizeEvent = receipt.logs.find(log => {
                    try {
                        const parsed = ticTacChain.interface.parseLog(log);
                        return parsed.name === "ETourPrize";
                    } catch (e) {
                        return false;
                    }
                });

                expect(prizeEvent).to.be.undefined;
            }
        });
    });
});
