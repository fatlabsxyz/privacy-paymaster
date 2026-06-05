// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IKeystorePP} from "./IKeystorePP.sol";
import {IASPRegistryPP} from "./IASPRegistryPP.sol";

/// @notice Minimal vendored interface for Privacy Pools v2 PoolVault.
interface IPoolVaultPP {
    struct TransactParams {
        address processor;
        bytes data;
    }

    struct NoteData {
        bytes32 hint;
        bytes data;
    }

    /// @notice Verifier address and function selector for a given NxM circuit.
    struct Verifier {
        address addr;
        bytes4 selector;
    }

    function spentNullifiers(uint256 _nullifierHash) external view returns (uint256 _spentAt);
    function isKnownRoot(uint256 _root) external view returns (bool _isKnown);
    function keystore() external view returns (IKeystorePP _keystore);
    function aspRegistry() external view returns (IASPRegistryPP _aspRegistry);
    function verifiers(bytes32 _key) external view returns (Verifier memory _verifier);
}
