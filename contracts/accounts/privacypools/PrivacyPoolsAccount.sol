// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

import {BasePrivacyAccount} from "../BasePrivacyAccount.sol";
import {IPrivacyPoolRelay} from "./interfaces/IPrivacyPoolRelay.sol";
import {IPoolVaultPP} from "./interfaces/IPoolVaultPP.sol";
import {IEntrypointPP} from "./interfaces/IEntrypointPP.sol";
import {ProofLibV2} from "./lib/ProofLibV2.sol";
import {ConstantsPP} from "./lib/ConstantsPP.sol";

/// @title PrivacyPoolsAccount
/// @notice ERC-4337 account for Privacy Pools v2 withdrawals and internal transfers.
///         Uses PrivacyPoolRelay as PROTOCOL_TARGET for atomic fee routing.
contract PrivacyPoolsAccount is BasePrivacyAccount {
    using ProofLibV2 for ProofLibV2.TransactProof;

    // ----- ERRORS -----
    error InvalidSelector(bytes4 selector);
    error InvalidProcessor(address processor);
    error InvalidFeeRecipient(address feeRecipient);
    error NonZeroNativeGas();
    error ZeroFee();
    error ZeroAmountOut();
    error FeeExceedsAmountOut(uint256 feeAmount, uint256 amountOut);
    error ContextMismatch(uint256 proofContext, uint256 computedContext);
    error FeeExceedsMaxRelayFee(uint256 feeAmount, uint256 maxRelayFee);
    error NullifierAlreadySpent(uint256 nullifierHash);
    error UnknownStateRoot(uint256 stateRoot);
    error UnknownKeystoreRoot(uint256 keystoreRoot);
    error InvalidASPRoot(uint256 proofRoot, uint256 expectedRoot);
    error UnsupportedCircuit(uint256 n, uint256 m);
    error ProofVerificationFailed();
    error VerifierCallReverted(bytes data);

    // ----- IMMUTABLES -----
    IPrivacyPoolRelay public immutable RELAY;
    IPoolVaultPP public immutable POOL_VAULT;
    IEntrypointPP public immutable PP_ENTRYPOINT;

    // ----- CONSTANTS -----
    uint8 private constant _FIXED_PUBSIGNALS = 6;

    constructor(
        IEntryPoint _entryPoint,
        IPrivacyPoolRelay _relay
    ) BasePrivacyAccount(_entryPoint, address(_relay)) {
        RELAY = _relay;
        POOL_VAULT = _relay.POOL();
        PP_ENTRYPOINT = _relay.ENTRYPOINT();
    }

    /// @notice Validates that feeCalldata will result in the paymaster receiving
    ///         the predicted fee when executed via the relay.
    /// @param feeCalldata ABI-encoded call to `IPrivacyPoolRelay.relay(...)`.
    /// @return feeToken The token address the fee is denominated in (address(0) for native ETH).
    /// @return feeAmount The fee amount the paymaster will receive.
    function previewFee(
        bytes calldata feeCalldata,
        bytes calldata /* paymasterAndData */
    )
        external
        view
        override
        returns (address feeToken, uint256 feeAmount)
    {
        address paymaster = msg.sender;

        // --- Step 1: Decode ---
        (
            ProofLibV2.TransactProof memory proof,
            IPoolVaultPP.TransactParams memory transactParams,
            IPoolVaultPP.NoteData[] memory noteData
        ) = _decode(feeCalldata);

        // --- Step 2: Structural checks (no external calls) ---
        if (transactParams.processor != address(RELAY)) {
            revert InvalidProcessor(transactParams.processor);
        }

        IPrivacyPoolRelay.PayoutRouting memory payout = abi.decode(
            transactParams.data,
            (IPrivacyPoolRelay.PayoutRouting)
        );

        if (payout.feeRecipient != paymaster) {
            revert InvalidFeeRecipient(payout.feeRecipient);
        }
        if (payout.nativeGas != 0) revert NonZeroNativeGas();
        if (payout.feeAmount == 0) revert ZeroFee();

        uint256 withdrawnValue = proof.amountOut();
        if (withdrawnValue == 0) revert ZeroAmountOut();
        if (withdrawnValue < payout.feeAmount) {
            revert FeeExceedsAmountOut(payout.feeAmount, withdrawnValue);
        }

        // --- Step 3: Context binding ---
        uint256 expectedContext = uint256(
            keccak256(abi.encode(transactParams, noteData))
        ) % ConstantsPP.SNARK_SCALAR_FIELD;

        uint256 proofContext = proof.context();
        if (proofContext != expectedContext) {
            revert ContextMismatch(proofContext, expectedContext);
        }

        // --- Step 4: Fee token + maxRelayFee ---
        address asset = proof.tokenIdOut();

        // Map PP v2 native asset sentinel to address(0) for paymaster compatibility.
        feeToken = asset == ConstantsPP.NATIVE_ASSET ? address(0) : asset;

        uint256 maxRelayFee = PP_ENTRYPOINT.assets(asset).maxRelayFee;
        if (payout.feeAmount > maxRelayFee) {
            revert FeeExceedsMaxRelayFee(payout.feeAmount, maxRelayFee);
        }

        // --- Step 5: Protocol state validation ---
        uint256[] memory nullifiers = proof.nullifierHashes();
        for (uint256 i; i < nullifiers.length; ++i) {
            if (POOL_VAULT.spentNullifiers(nullifiers[i]) != 0) {
                revert NullifierAlreadySpent(nullifiers[i]);
            }
        }

        if (!POOL_VAULT.isKnownRoot(proof.stateRoot())) {
            revert UnknownStateRoot(proof.stateRoot());
        }

        if (!POOL_VAULT.keystore().isKnownRoot(proof.keyRegistryRoot())) {
            revert UnknownKeystoreRoot(proof.keyRegistryRoot());
        }

        uint256 aspRoot = proof.associationSetRoot();
        uint256 latestASPRoot = POOL_VAULT.aspRegistry().latestASPRoot();
        if (aspRoot != latestASPRoot) {
            revert InvalidASPRoot(aspRoot, latestASPRoot);
        }

        // --- Step 6: Groth16 proof verification ---
        _verifyProof(proof);

        feeAmount = payout.feeAmount;
    }

    // ----- INTERNAL -----

    /// @dev Decodes feeCalldata as a call to `IPrivacyPoolRelay.relay(...)`.
    function _decode(
        bytes calldata feeCalldata
    )
        internal
        pure
        returns (
            ProofLibV2.TransactProof memory proof,
            IPoolVaultPP.TransactParams memory transactParams,
            IPoolVaultPP.NoteData[] memory noteData
        )
    {
        bytes4 sel = bytes4(feeCalldata[:4]);
        if (sel != IPrivacyPoolRelay.relay.selector) {
            revert InvalidSelector(sel);
        }

        (proof, transactParams, noteData) = abi.decode(
            feeCalldata[4:],
            (ProofLibV2.TransactProof, IPoolVaultPP.TransactParams, IPoolVaultPP.NoteData[])
        );
    }

    /// @dev Verifies the Groth16 proof by looking up the appropriate verifier
    ///      from the PoolVault's TransactVerifierRouter and staticcalling it.
    ///      Replicates the encoding from TransactVerifierRouter._verifyProof.
    function _verifyProof(ProofLibV2.TransactProof memory proof) internal view {
        uint256[] memory nullifiers = proof.nullifierHashes();
        uint256[] memory commitments = proof.outputCommitments();
        uint256 n = nullifiers.length;
        uint256 m = commitments.length;

        bytes32 key = keccak256(abi.encode(n, m));
        IPoolVaultPP.Verifier memory verifier = POOL_VAULT.verifiers(key);

        if (verifier.addr == address(0)) {
            revert UnsupportedCircuit(n, m);
        }

        // Build calldata matching TransactVerifierRouter._verifyProof format:
        // selector + pA + pB + pC + nullifiers + commitments + fixedSignals
        bytes memory verifierCalldata = abi.encodePacked(
            verifier.selector,
            proof.pA,
            proof.pB,
            proof.pC
        );

        verifierCalldata = abi.encodePacked(
            verifierCalldata,
            nullifiers,
            commitments
        );

        uint256[_FIXED_PUBSIGNALS] memory fixedSignals;
        fixedSignals[0] = proof.stateRoot();
        fixedSignals[1] = proof.keyRegistryRoot();
        fixedSignals[2] = proof.associationSetRoot();
        fixedSignals[3] = proof.amountOut();
        fixedSignals[4] = uint256(uint160(proof.tokenIdOut()));
        fixedSignals[5] = proof.context();

        verifierCalldata = abi.encodePacked(verifierCalldata, fixedSignals);

        (bool success, bytes memory retdata) = verifier.addr.staticcall(verifierCalldata);
        if (!success) revert VerifierCallReverted(retdata);

        bool valid = abi.decode(retdata, (bool));
        if (!valid) revert ProofVerificationFailed();
    }
}
