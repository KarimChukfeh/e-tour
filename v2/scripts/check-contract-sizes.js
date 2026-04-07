// scripts/check-contract-sizes.js
// Check compiled contract sizes against 24KB Spurious Dragon limit

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 24KB limit (Spurious Dragon)
const SPURIOUS_DRAGON_LIMIT = 24576; // bytes
const LIMIT_KB = SPURIOUS_DRAGON_LIMIT / 1024;

// Factory contracts
const FACTORIES = [
    'TicTacToeFactory',
    'ChessFactory',
    'ConnectFourFactory',
    'ETourFactory'
];

// Instance implementation contracts (deployed once, cloned via EIP-1167)
const INSTANCES = [
    'TicTacToe',
    'Chess',
    'ConnectFour',
    'ETourInstance',
    'ETourTournamentBase'
];

// Abstract/shared template contracts (not directly deployed, but still useful
// to track as part of the developer-facing contract surface)
const TEMPLATES = [
    'ETourGame'
];

// Shared module contracts (deployed once, delegatecall from instances)
const MODULES = [
    'contracts/modules/ETourInstance_Core.sol:ETourInstance_Core',
    'contracts/modules/ETourInstance_Matches.sol:ETourInstance_Matches',
    'contracts/modules/ETourInstance_MatchesResolution.sol:ETourInstance_MatchesResolution',
    'contracts/modules/ETourInstance_Prizes.sol:ETourInstance_Prizes',
    'contracts/modules/ETourInstance_Escalation.sol:ETourInstance_Escalation',
    'contracts/modules/ChessRulesModule.sol:ChessRulesModule'
];

// Supporting contracts
const SUPPORT = [
    'PlayerProfile',
    'PlayerRegistry'
];

function getContractSize(contractName) {
    try {
        const artifactPath = path.join(__dirname, '..', 'artifacts', 'contracts', `${contractName}.sol`, `${contractName}.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        // Get deployed bytecode (more accurate for deployment size)
        const bytecode = artifact.deployedBytecode || artifact.bytecode;

        // Remove '0x' prefix and calculate size
        const bytecodeWithout0x = bytecode.replace('0x', '');
        const sizeInBytes = bytecodeWithout0x.length / 2; // 2 hex chars = 1 byte

        return sizeInBytes;
    } catch (error) {
        return null;
    }
}

function getModuleSize(modulePath) {
    try {
        // modulePath format: "contracts/modules/ETourInstance_Core.sol:ETourInstance_Core"
        const [filePath, contractName] = modulePath.split(':');
        const fileName = filePath.split('/').pop(); // Get "ETourInstance_Core.sol"

        const artifactPath = path.join(__dirname, '..', 'artifacts', 'contracts', 'modules', fileName, `${contractName}.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        const bytecode = artifact.deployedBytecode || artifact.bytecode;
        const bytecodeWithout0x = bytecode.replace('0x', '');
        const sizeInBytes = bytecodeWithout0x.length / 2;

        return sizeInBytes;
    } catch (error) {
        return null;
    }
}

function formatSize(bytes) {
    const kb = (bytes / 1024).toFixed(2);
    const percentage = ((bytes / SPURIOUS_DRAGON_LIMIT) * 100).toFixed(1);
    return { bytes, kb, percentage };
}

function getStatusIcon(bytes) {
    if (bytes > SPURIOUS_DRAGON_LIMIT) {
        return '❌';
    } else if (bytes > SPURIOUS_DRAGON_LIMIT * 0.9) {
        return '⚠️ ';
    } else {
        return '✅';
    }
}

function printSection(title, contracts, getSize) {
    console.log('');
    console.log(title);
    console.log('-'.repeat(70));

    let totalSize = 0;
    let contractData = [];

    for (const contract of contracts) {
        const displayName = typeof contract === 'string' && contract.includes(':')
            ? contract.split(':')[1]
            : contract;

        const size = getSize(contract);
        if (size !== null) {
            const formatted = formatSize(size);
            const status = getStatusIcon(size);

            contractData.push({
                name: displayName,
                ...formatted,
                status
            });

            totalSize += size;
        }
    }

    // Sort by size (largest first)
    contractData.sort((a, b) => b.bytes - a.bytes);

    // Print table
    for (const data of contractData) {
        const statusText = data.bytes > SPURIOUS_DRAGON_LIMIT ? 'OVER LIMIT' : 'OK';
        console.log(`${data.status}  ${data.name.padEnd(30)} ${data.bytes.toString().padStart(6)} bytes  ${data.percentage.padStart(5)}%  ${statusText}`);
    }

    return { contractData, totalSize };
}

console.log('');
console.log('='.repeat(70));
console.log('📊  Contract Size Report (v2 - Factory/Instance Architecture)');
console.log('='.repeat(70));
console.log(`Spurious Dragon Limit: ${LIMIT_KB} KB (${SPURIOUS_DRAGON_LIMIT} bytes)`);

// Check factory contracts
const { contractData: factoryData, totalSize: totalFactorySize } = printSection(
    '🏭  Factory Contracts:',
    FACTORIES,
    getContractSize
);

// Check instance implementation contracts
const { contractData: instanceData, totalSize: totalInstanceSize } = printSection(
    '🎮  Instance Implementation Contracts (EIP-1167 clones):',
    INSTANCES,
    getContractSize
);

// Check abstract/shared template contracts
const { contractData: templateData, totalSize: totalTemplateSize } = printSection(
    '🧩  Shared Template Contracts:',
    TEMPLATES,
    getContractSize
);

// Check module contracts
const { contractData: moduleData, totalSize: totalModuleSize } = printSection(
    '📚  Shared Module Contracts (delegatecall):',
    MODULES,
    getModuleSize
);

// Check supporting contracts
const { contractData: supportData, totalSize: totalSupportSize } = printSection(
    '🔧  Supporting Contracts:',
    SUPPORT,
    getContractSize
);

console.log('');
console.log('='.repeat(70));
console.log('📊  Summary:');
console.log('-'.repeat(70));

const avgFactorySize = factoryData.length > 0 ? totalFactorySize / factoryData.length : 0;
const avgInstanceSize = instanceData.length > 0 ? totalInstanceSize / instanceData.length : 0;
const avgModuleSize = moduleData.length > 0 ? totalModuleSize / moduleData.length : 0;

console.log(`Total Factory Contracts Size:     ${totalFactorySize.toLocaleString()} bytes`);
console.log(`Average Factory Contract Size:    ${Math.round(avgFactorySize).toLocaleString()} bytes`);
console.log('');
console.log(`Total Instance Contracts Size:    ${totalInstanceSize.toLocaleString()} bytes`);
console.log(`Average Instance Contract Size:   ${Math.round(avgInstanceSize).toLocaleString()} bytes`);
console.log('');
console.log(`Total Template Contracts Size:    ${totalTemplateSize.toLocaleString()} bytes`);
console.log('');
console.log(`Total Module Contracts Size:      ${totalModuleSize.toLocaleString()} bytes`);
console.log(`Average Module Contract Size:     ${Math.round(avgModuleSize).toLocaleString()} bytes`);
console.log('');
console.log(`Total Supporting Contracts Size:  ${totalSupportSize.toLocaleString()} bytes`);
console.log('');

// Calculate benefits of modular architecture
console.log('💡  Modular Architecture Benefits (EIP-1167 + Delegatecall):');
console.log('-'.repeat(70));
console.log('Each tournament instance is an EIP-1167 minimal proxy (~200 bytes)');
console.log('Instance implementation deployed once, cloned infinitely');
console.log('Modules deployed once, shared via delegatecall');
console.log('');

const gameCount = instanceData.filter(d =>
    d.name.includes('TicTac') || d.name.includes('Chess') || d.name.includes('ConnectFour')
).length;

if (gameCount > 0) {
    const avgGameInstanceSize = instanceData
        .filter(d => d.name.includes('TicTac') || d.name.includes('Chess') || d.name.includes('ConnectFour'))
        .reduce((sum, d) => sum + d.bytes, 0) / gameCount;

    console.log(`Average Game Instance Size:       ${Math.round(avgGameInstanceSize).toLocaleString()} bytes`);
    console.log(`EIP-1167 Proxy Size:              ~200 bytes (per tournament)`);
    console.log(`Space Savings per Tournament:     ${Math.round(avgGameInstanceSize - 200).toLocaleString()} bytes (${((1 - 200/avgGameInstanceSize) * 100).toFixed(1)}%)`);
    console.log('');

    const tournamentCount = 1000;
    const monolithicTotal = avgGameInstanceSize * tournamentCount;
    const proxyTotal = avgGameInstanceSize + (200 * tournamentCount);
    const savings = monolithicTotal - proxyTotal;

    console.log(`For ${tournamentCount.toLocaleString()} tournaments:`);
    console.log(`  Monolithic approach:            ${(monolithicTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  EIP-1167 proxy approach:        ${(proxyTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Total savings:                  ${(savings / 1024 / 1024).toFixed(2)} MB (${((savings / monolithicTotal) * 100).toFixed(1)}%)`);
    console.log('');
}

// Check for contracts over limit
const allContracts = [...factoryData, ...instanceData, ...templateData, ...moduleData, ...supportData];
const overLimit = allContracts.filter(d => d.bytes > SPURIOUS_DRAGON_LIMIT);
const nearLimit = allContracts.filter(d => d.bytes > SPURIOUS_DRAGON_LIMIT * 0.9 && d.bytes <= SPURIOUS_DRAGON_LIMIT);

if (overLimit.length > 0) {
    console.log('❌  Contracts Over 24KB Limit:');
    console.log('-'.repeat(70));
    for (const contract of overLimit) {
        const excess = contract.bytes - SPURIOUS_DRAGON_LIMIT;
        console.log(`  ${contract.name}: ${excess.toLocaleString()} bytes over limit (${((excess / SPURIOUS_DRAGON_LIMIT) * 100).toFixed(1)}% over)`);
    }
    console.log('');
    console.log('💡  Recommendations:');
    console.log('  - Increase optimizer runs in hardhat.config.js');
    console.log('  - Consider splitting large contracts into additional modules');
    console.log('  - Remove unnecessary string error messages (use custom errors)');
    console.log('  - Use libraries for common functionality');
    console.log('  - Consider moving view functions to separate helper contracts');
    console.log('');
} else if (nearLimit.length > 0) {
    console.log('⚠️   Contracts Near 24KB Limit (>90%):');
    console.log('-'.repeat(70));
    for (const contract of nearLimit) {
        const remaining = SPURIOUS_DRAGON_LIMIT - contract.bytes;
        console.log(`  ${contract.name}: ${remaining.toLocaleString()} bytes remaining (${contract.percentage}% used)`);
    }
    console.log('');
    console.log('💡  Consider optimizations to maintain headroom for future features.');
    console.log('');
} else {
    console.log('✅  All contracts are comfortably within the 24KB limit!');
    console.log('');
}

console.log('='.repeat(70));
console.log('');
