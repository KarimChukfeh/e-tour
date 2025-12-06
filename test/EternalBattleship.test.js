// test/EternalBattleship.test.js
// Test suite for EternalBattleship v3 - Commit-Reveal with Wallet Signatures

import { expect } from "chai";
import hre from "hardhat";

describe("EternalBattleship - Commit-Reveal with Wallet Signatures", function () {
    let game;
    let owner, player1, player2, player3, player4;

    // Standard ship positions for testing
    const PLAYER1_SHIPS = [0, 1, 2, 3, 4, 20, 21, 22, 23, 40, 41, 42, 60, 61, 62, 80, 81];
    const PLAYER2_SHIPS = [9, 19, 29, 39, 49, 7, 17, 27, 37, 5, 15, 25, 53, 63, 73, 88, 98];

    beforeEach(async function () {
        [owner, player1, player2, player3, player4] = await hre.ethers.getSigners();

        const EternalBattleship = await hre.ethers.getContractFactory("EternalBattleship");
        game = await EternalBattleship.deploy();
        await game.waitForDeployment();
    });

    // Helper to sign the tournament commit message (signed once at enrollment, used for all matches)
    async function signCommitMessage(signer, tierId, instanceId) {
        const messageHash = await game.getCommitMessage(tierId, instanceId, signer.address);
        const signature = await signer.signMessage(hre.ethers.getBytes(messageHash));
        return signature;
    }

    // Helper to generate commitment
    async function generateCommitment(shipPositions, signature) {
        return await game.generateCommitment(shipPositions, signature);
    }

    describe("Deployment", function () {
        it("Should deploy with correct constants", async function () {
            expect(await game.BOARD_SIZE()).to.equal(100);
            expect(await game.BOARD_WIDTH()).to.equal(10);
            expect(await game.TOTAL_SHIP_CELLS()).to.equal(17);
        });

        it("Should register tournament tiers", async function () {
            const tier0 = await game.tierConfigs(0);
            expect(tier0.playerCount).to.equal(2);
            expect(tier0.instanceCount).to.equal(10);
        });
    });

    describe("Signature Verification", function () {
        it("Should verify valid signature", async function () {
            const messageHash = await game.getCommitMessage(0, 0, player1.address);
            const signature = await player1.signMessage(hre.ethers.getBytes(messageHash));

            const isValid = await game.verifySignature(messageHash, signature, player1.address);
            expect(isValid).to.be.true;
        });

        it("Should reject signature from wrong signer", async function () {
            const messageHash = await game.getCommitMessage(0, 0, player1.address);
            const signature = await player2.signMessage(hre.ethers.getBytes(messageHash));

            const isValid = await game.verifySignature(messageHash, signature, player1.address);
            expect(isValid).to.be.false;
        });
    });

    describe("Commitment Generation", function () {
        it("Should generate consistent commitment", async function () {
            const signature = await signCommitMessage(player1, 0, 0);

            const commitment1 = await generateCommitment(PLAYER1_SHIPS, signature);
            const commitment2 = await generateCommitment(PLAYER1_SHIPS, signature);

            expect(commitment1).to.equal(commitment2);
        });

        it("Should generate different commitments for different boards", async function () {
            const signature = await signCommitMessage(player1, 0, 0);

            const commitment1 = await generateCommitment(PLAYER1_SHIPS, signature);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, signature);

            expect(commitment1).to.not.equal(commitment2);
        });
    });

    describe("Tournament Enrollment", function () {
        it("Should enroll players and auto-start 2-player tournament", async function () {
            const tierId = 0;
            const instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.005");

            await expect(game.connect(player1).enrollInTournament(tierId, instanceId, {
                value: entryFee
            })).to.emit(game, "PlayerEnrolled");

            await expect(game.connect(player2).enrollInTournament(tierId, instanceId, {
                value: entryFee
            })).to.emit(game, "TournamentStarted");

            const tournament = await game.tournaments(tierId, instanceId);
            expect(tournament.status).to.equal(1); // InProgress
        });

        it("Should find player match via findPlayerMatch helper", async function () {
            const tierId = 0;
            const instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.005");

            // Enroll both players
            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Find player1's match
            const match1 = await game.findPlayerMatch(player1.address);
            expect(match1.found).to.be.true;
            expect(match1.tierId).to.equal(0);
            expect(match1.instanceId).to.equal(0);
            expect(match1.roundNumber).to.equal(0);
            expect(match1.matchNumber).to.equal(0);
            expect(match1.phase).to.equal(1); // AwaitingCommitments
            expect(match1.opponent).to.equal(player2.address);
            expect(match1.playerHasCommitted).to.be.false;
            expect(match1.opponentHasCommitted).to.be.false;

            // Find player2's match
            const match2 = await game.findPlayerMatch(player2.address);
            expect(match2.found).to.be.true;
            expect(match2.opponent).to.equal(player1.address);

            // Player3 shouldn't have a match
            const match3 = await game.findPlayerMatch(player3.address);
            expect(match3.found).to.be.false;
        });
    });

    describe("Commit-Reveal Flow", function () {
        let tierId, instanceId, entryFee;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;
            entryFee = hre.ethers.parseEther("0.005");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
        });

        it("Should start in AwaitingCommitments phase", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);
            expect(state.phase).to.equal(1); // AwaitingCommitments
        });

        it("Should allow players to commit their boards", async function () {
            // Player 1 commits
            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);

            await expect(game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1))
                .to.emit(game, "BoardCommitted")
                .withArgs(await getMatchId(tierId, instanceId, 0, 0), player1.address);

            let state = await game.getMatchState(tierId, instanceId, 0, 0);
            expect(state.player1Committed).to.be.true;
            expect(state.player2Committed).to.be.false;
            expect(state.phase).to.equal(1); // Still AwaitingCommitments

            // Player 2 commits
            const sig2 = await signCommitMessage(player2, tierId, instanceId);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, sig2);

            await expect(game.connect(player2).commitBoard(tierId, instanceId, 0, 0, commitment2))
                .to.emit(game, "BoardCommitted");

            // Should transition to AwaitingReveals
            state = await game.getMatchState(tierId, instanceId, 0, 0);
            expect(state.player1Committed).to.be.true;
            expect(state.player2Committed).to.be.true;
            expect(state.phase).to.equal(2); // AwaitingReveals
        });

        it("Should prevent double commitment", async function () {
            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);

            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            await expect(
                game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1)
            ).to.be.revertedWith("Already committed");
        });

        it("Should allow reveal after both commit", async function () {
            // Both commit
            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);
            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            const sig2 = await signCommitMessage(player2, tierId, instanceId);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, sig2);
            await game.connect(player2).commitBoard(tierId, instanceId, 0, 0, commitment2);

            // Player 1 reveals
            await expect(game.connect(player1).revealBoard(tierId, instanceId, 0, 0, PLAYER1_SHIPS, sig1))
                .to.emit(game, "BoardRevealed")
                .withArgs(await getMatchId(tierId, instanceId, 0, 0), player1.address);

            let state = await game.getMatchState(tierId, instanceId, 0, 0);
            expect(state.player1Revealed).to.be.true;
            expect(state.player2Revealed).to.be.false;
            expect(state.phase).to.equal(2); // Still AwaitingReveals

            // Player 2 reveals
            await game.connect(player2).revealBoard(tierId, instanceId, 0, 0, PLAYER2_SHIPS, sig2);

            // Should transition to InProgress
            state = await game.getMatchState(tierId, instanceId, 0, 0);
            expect(state.player1Revealed).to.be.true;
            expect(state.player2Revealed).to.be.true;
            expect(state.phase).to.equal(3); // InProgress
        });

        it("Should reject reveal with wrong signature", async function () {
            // Both commit with their own signatures
            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);
            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            const sig2 = await signCommitMessage(player2, tierId, instanceId);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, sig2);
            await game.connect(player2).commitBoard(tierId, instanceId, 0, 0, commitment2);

            // Player1 tries to reveal with player2's signature
            await expect(
                game.connect(player1).revealBoard(tierId, instanceId, 0, 0, PLAYER1_SHIPS, sig2)
            ).to.be.revertedWith("Invalid signature");
        });

        it("Should reject reveal with wrong ship positions", async function () {
            // Commit with PLAYER1_SHIPS
            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);
            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            const sig2 = await signCommitMessage(player2, tierId, instanceId);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, sig2);
            await game.connect(player2).commitBoard(tierId, instanceId, 0, 0, commitment2);

            // Try to reveal with PLAYER2_SHIPS (wrong board)
            await expect(
                game.connect(player1).revealBoard(tierId, instanceId, 0, 0, PLAYER2_SHIPS, sig1)
            ).to.be.revertedWith("Commitment mismatch");
        });
    });

    describe("Gameplay - Fire Shot", function () {
        let tierId, instanceId;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.005");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            // Complete commit-reveal
            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);
            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            const sig2 = await signCommitMessage(player2, tierId, instanceId);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, sig2);
            await game.connect(player2).commitBoard(tierId, instanceId, 0, 0, commitment2);

            await game.connect(player1).revealBoard(tierId, instanceId, 0, 0, PLAYER1_SHIPS, sig1);
            await game.connect(player2).revealBoard(tierId, instanceId, 0, 0, PLAYER2_SHIPS, sig2);
        });

        it("Should be in InProgress phase after both reveal", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);
            expect(state.phase).to.equal(3); // InProgress
        });

        it("Should allow current turn player to fire", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);
            const shooter = state.currentTurn === player1.address ? player1 : player2;

            await expect(game.connect(shooter).fireShot(tierId, instanceId, 0, 0, 50))
                .to.emit(game, "ShotFired");
        });

        it("Should detect hit when shooting at ship", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);

            let shooter, targetShipCell;
            if (state.currentTurn === player1.address) {
                shooter = player1;
                targetShipCell = 9; // Player2's carrier
            } else {
                shooter = player2;
                targetShipCell = 0; // Player1's carrier
            }

            await expect(game.connect(shooter).fireShot(tierId, instanceId, 0, 0, targetShipCell))
                .to.emit(game, "ShotFired")
                .withArgs(await getMatchId(tierId, instanceId, 0, 0), shooter.address, targetShipCell, true);
        });

        it("Should detect miss when shooting at empty cell", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);
            const shooter = state.currentTurn === player1.address ? player1 : player2;

            await expect(game.connect(shooter).fireShot(tierId, instanceId, 0, 0, 50))
                .to.emit(game, "ShotFired")
                .withArgs(await getMatchId(tierId, instanceId, 0, 0), shooter.address, 50, false);
        });

        it("Should switch turns after shot", async function () {
            const state1 = await game.getMatchState(tierId, instanceId, 0, 0);
            const firstShooter = state1.currentTurn;

            const shooter = firstShooter === player1.address ? player1 : player2;
            await game.connect(shooter).fireShot(tierId, instanceId, 0, 0, 50);

            const state2 = await game.getMatchState(tierId, instanceId, 0, 0);
            expect(state2.currentTurn).to.not.equal(firstShooter);
        });

        it("Should prevent shooting same cell twice", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);
            const shooter = state.currentTurn === player1.address ? player1 : player2;
            const opponent = state.currentTurn === player1.address ? player2 : player1;

            await game.connect(shooter).fireShot(tierId, instanceId, 0, 0, 50);
            await game.connect(opponent).fireShot(tierId, instanceId, 0, 0, 51);

            await expect(
                game.connect(shooter).fireShot(tierId, instanceId, 0, 0, 50)
            ).to.be.revertedWith("Cell already shot");
        });
    });

    describe("Fog of War - Access Control", function () {
        let tierId, instanceId;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.005");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);
            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            const sig2 = await signCommitMessage(player2, tierId, instanceId);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, sig2);
            await game.connect(player2).commitBoard(tierId, instanceId, 0, 0, commitment2);

            await game.connect(player1).revealBoard(tierId, instanceId, 0, 0, PLAYER1_SHIPS, sig1);
            await game.connect(player2).revealBoard(tierId, instanceId, 0, 0, PLAYER2_SHIPS, sig2);
        });

        it("Should allow player to see their own board fully", async function () {
            const myBoard = await game.connect(player1).getMyBoard(tierId, instanceId, 0, 0);

            // CellState enum: Empty=0, Ship=1, Hit=2, Miss=3
            expect(myBoard[0]).to.equal(1); // Ship
            expect(myBoard[1]).to.equal(1);
            expect(myBoard[20]).to.equal(1);
        });

        it("Should hide opponent's unshot cells", async function () {
            const opponentBoard = await game.connect(player1).getOpponentBoard(tierId, instanceId, 0, 0);

            for (let i = 0; i < 100; i++) {
                expect(opponentBoard[i]).to.equal(0); // Empty (hidden)
            }
        });

        it("Should reveal opponent cells after shooting", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);

            let shooter, targetShipCell;
            if (state.currentTurn === player1.address) {
                shooter = player1;
                targetShipCell = 9;
            } else {
                shooter = player2;
                targetShipCell = 0;
            }

            await game.connect(shooter).fireShot(tierId, instanceId, 0, 0, targetShipCell);

            const opponentBoard = await game.connect(shooter).getOpponentBoard(tierId, instanceId, 0, 0);

            // CellState enum: Empty=0, Ship=1, Hit=2, Miss=3
            expect(opponentBoard[targetShipCell]).to.equal(2); // Hit

            const otherCell = 50;
            expect(opponentBoard[otherCell]).to.equal(0); // Empty (hidden)
        });

        it("Should prevent non-players from viewing boards", async function () {
            await expect(
                game.connect(player3).getMyBoard(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Not a player");

            await expect(
                game.connect(player3).getOpponentBoard(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("Not a player");
        });
    });

    describe("Win Detection", function () {
        let tierId, instanceId;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;
            const entryFee = hre.ethers.parseEther("0.005");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });

            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);
            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            const sig2 = await signCommitMessage(player2, tierId, instanceId);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, sig2);
            await game.connect(player2).commitBoard(tierId, instanceId, 0, 0, commitment2);

            await game.connect(player1).revealBoard(tierId, instanceId, 0, 0, PLAYER1_SHIPS, sig1);
            await game.connect(player2).revealBoard(tierId, instanceId, 0, 0, PLAYER2_SHIPS, sig2);
        });

        it("Should track ships remaining correctly", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);
            expect(state.player1ShipsRemaining).to.equal(17);
            expect(state.player2ShipsRemaining).to.equal(17);
        });

        it("Should declare winner when all ships sunk", async function () {
            const state = await game.getMatchState(tierId, instanceId, 0, 0);
            let currentTurn = state.currentTurn;

            const p2Ships = [9, 19, 29, 39, 49, 7, 17, 27, 37, 5, 15, 25, 53, 63, 73, 88, 98];
            const p1EmptyCells = [10, 11, 12, 13, 14, 15, 16, 18, 19, 30, 31, 32, 33, 34, 35, 36, 37];

            let p1ShipIndex = 0;
            let p2EmptyIndex = 0;
            let winner = null;

            for (let turn = 0; turn < 35 && winner === null; turn++) {
                let tx;
                if (currentTurn === player1.address) {
                    if (p1ShipIndex >= p2Ships.length) break;
                    tx = await game.connect(player1).fireShot(tierId, instanceId, 0, 0, p2Ships[p1ShipIndex]);
                    p1ShipIndex++;
                } else {
                    if (p2EmptyIndex >= p1EmptyCells.length) break;
                    tx = await game.connect(player2).fireShot(tierId, instanceId, 0, 0, p1EmptyCells[p2EmptyIndex]);
                    p2EmptyIndex++;
                }

                const receipt = await tx.wait();
                const tournamentCompletedEvent = receipt.logs.find(
                    log => {
                        try {
                            const parsed = game.interface.parseLog(log);
                            return parsed && parsed.name === "TournamentCompleted";
                        } catch {
                            return false;
                        }
                    }
                );

                if (tournamentCompletedEvent) {
                    const parsed = game.interface.parseLog(tournamentCompletedEvent);
                    winner = parsed.args.winner;
                    expect(winner).to.equal(player1.address);
                    return;
                }

                currentTurn = currentTurn === player1.address ? player2.address : player1.address;
            }

            expect(winner).to.not.be.null;
        });
    });

    describe("Timeout Handling", function () {
        let tierId, instanceId, entryFee;

        beforeEach(async function () {
            tierId = 0;
            instanceId = 0;
            entryFee = hre.ethers.parseEther("0.005");

            await game.connect(player1).enrollInTournament(tierId, instanceId, { value: entryFee });
            await game.connect(player2).enrollInTournament(tierId, instanceId, { value: entryFee });
        });

        it("Should allow timeout claim during commitment phase", async function () {
            // Only player1 commits
            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);
            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            // Fast forward past timeout
            await hre.ethers.provider.send("evm_increaseTime", [180]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(game.connect(player1).claimTimeoutWin(tierId, instanceId, 0, 0))
                .to.emit(game, "TimeoutVictoryClaimed")
                .withArgs(tierId, instanceId, 0, 0, player1.address, player2.address);
        });

        it("Should allow timeout claim during reveal phase", async function () {
            // Both commit
            const sig1 = await signCommitMessage(player1, tierId, instanceId);
            const commitment1 = await generateCommitment(PLAYER1_SHIPS, sig1);
            await game.connect(player1).commitBoard(tierId, instanceId, 0, 0, commitment1);

            const sig2 = await signCommitMessage(player2, tierId, instanceId);
            const commitment2 = await generateCommitment(PLAYER2_SHIPS, sig2);
            await game.connect(player2).commitBoard(tierId, instanceId, 0, 0, commitment2);

            // Only player1 reveals
            await game.connect(player1).revealBoard(tierId, instanceId, 0, 0, PLAYER1_SHIPS, sig1);

            // Fast forward past timeout
            await hre.ethers.provider.send("evm_increaseTime", [180]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(game.connect(player1).claimTimeoutWin(tierId, instanceId, 0, 0))
                .to.emit(game, "TimeoutVictoryClaimed")
                .withArgs(tierId, instanceId, 0, 0, player1.address, player2.address);
        });

        it("Should require committing before claiming timeout", async function () {
            await hre.ethers.provider.send("evm_increaseTime", [180]);
            await hre.ethers.provider.send("evm_mine", []);

            await expect(
                game.connect(player1).claimTimeoutWin(tierId, instanceId, 0, 0)
            ).to.be.revertedWith("You must commit first");
        });
    });

    describe("RW3 Declaration", function () {
        it("Should return RW3 compliance declaration", async function () {
            const declaration = await game.declareRW3();
            expect(declaration).to.include("RW3 COMPLIANCE DECLARATION");
            expect(declaration).to.include("EternalBattleship");
            expect(declaration).to.include("Commit-Reveal");
            expect(declaration).to.include("wallet signature");
        });
    });

    // Helper function to compute match ID
    async function getMatchId(tierId, instanceId, roundNumber, matchNumber) {
        return hre.ethers.solidityPackedKeccak256(
            ["uint8", "uint8", "uint8", "uint8"],
            [tierId, instanceId, roundNumber, matchNumber]
        );
    }
});
