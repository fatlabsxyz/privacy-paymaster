// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ProofLibV2
/// @notice Minimal vendored subset of Privacy Pools v2 ProofLibV2 — transact proof only.
/// @dev Uses `memory` parameters (upstream uses `calldata`) because previewFee decodes
///      feeCalldata via abi.decode which returns memory types.
library ProofLibV2 {
    /// @notice Groth16 proof components and public signals for transact circuit.
    struct TransactProof {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[][] pubSignals;
    }

    error ProofLib_TokenIdNotCanonical(uint256 _raw);

    // ----- TransactProof accessors -----

    function nullifierHashes(TransactProof memory _proof) internal pure returns (uint256[] memory) {
        return _proof.pubSignals[0];
    }

    function outputCommitments(TransactProof memory _proof) internal pure returns (uint256[] memory) {
        return _proof.pubSignals[1];
    }

    function stateRoot(TransactProof memory _proof) internal pure returns (uint256) {
        return _proof.pubSignals[2][0];
    }

    function keyRegistryRoot(TransactProof memory _proof) internal pure returns (uint256) {
        return _proof.pubSignals[3][0];
    }

    function associationSetRoot(TransactProof memory _proof) internal pure returns (uint256) {
        return _proof.pubSignals[4][0];
    }

    function amountOut(TransactProof memory _proof) internal pure returns (uint256) {
        return _proof.pubSignals[5][0];
    }

    function tokenIdOut(TransactProof memory _proof) internal pure returns (address) {
        uint256 _raw = _proof.pubSignals[6][0];
        require(_raw >> 160 == 0, ProofLib_TokenIdNotCanonical(_raw));
        return address(uint160(_raw));
    }

    function context(TransactProof memory _proof) internal pure returns (uint256) {
        return _proof.pubSignals[7][0];
    }
}
