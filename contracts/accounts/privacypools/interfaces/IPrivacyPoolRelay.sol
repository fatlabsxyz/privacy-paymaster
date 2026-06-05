// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolVaultPP} from "./IPoolVaultPP.sol";
import {IEntrypointPP} from "./IEntrypointPP.sol";
import {ProofLibV2} from "../lib/ProofLibV2.sol";

/// @notice Minimal vendored interface for Privacy Pools v2 PrivacyPoolRelay.
interface IPrivacyPoolRelay {
    struct PayoutRouting {
        address recipient;
        address feeRecipient;
        uint256 feeAmount;
        uint256 nativeGas;
    }

    function relay(
        ProofLibV2.TransactProof calldata _proof,
        IPoolVaultPP.TransactParams calldata _transactParams,
        IPoolVaultPP.NoteData[] calldata _noteData
    ) external payable;

    function POOL() external view returns (IPoolVaultPP _pool);
    function ENTRYPOINT() external view returns (IEntrypointPP _entrypoint);
}
