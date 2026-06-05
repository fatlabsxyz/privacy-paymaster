// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

import {PrivacyPoolsAccount} from "../contracts/accounts/privacypools/PrivacyPoolsAccount.sol";
import {IPrivacyPoolRelay} from "../contracts/accounts/privacypools/interfaces/IPrivacyPoolRelay.sol";
import {IPoolVaultPP} from "../contracts/accounts/privacypools/interfaces/IPoolVaultPP.sol";
import {IEntrypointPP} from "../contracts/accounts/privacypools/interfaces/IEntrypointPP.sol";
import {IKeystorePP} from "../contracts/accounts/privacypools/interfaces/IKeystorePP.sol";
import {IASPRegistryPP} from "../contracts/accounts/privacypools/interfaces/IASPRegistryPP.sol";
import {ProofLibV2} from "../contracts/accounts/privacypools/lib/ProofLibV2.sol";
import {ConstantsPP} from "../contracts/accounts/privacypools/lib/ConstantsPP.sol";

// ----- Mock contracts -----

contract MockRelay is IPrivacyPoolRelay {
    IPoolVaultPP public immutable POOL;
    IEntrypointPP public immutable ENTRYPOINT;

    constructor(IPoolVaultPP _pool, IEntrypointPP _entrypoint) {
        POOL = _pool;
        ENTRYPOINT = _entrypoint;
    }

    function relay(
        ProofLibV2.TransactProof calldata,
        IPoolVaultPP.TransactParams calldata,
        IPoolVaultPP.NoteData[] calldata
    ) external payable {}
}

contract MockPoolVault {
    IKeystorePP public keystoreAddr;
    IASPRegistryPP public aspRegistryAddr;

    mapping(uint256 => uint256) public spentNullifiers;
    mapping(uint256 => bool) public knownRoots;
    mapping(bytes32 => IPoolVaultPP.Verifier) public _verifiers;

    function setKeystore(IKeystorePP _keystore) external {
        keystoreAddr = _keystore;
    }

    function setAspRegistry(IASPRegistryPP _aspRegistry) external {
        aspRegistryAddr = _aspRegistry;
    }

    function setSpentNullifier(uint256 _hash, uint256 _spentAt) external {
        spentNullifiers[_hash] = _spentAt;
    }

    function setKnownRoot(uint256 _root, bool _known) external {
        knownRoots[_root] = _known;
    }

    function setVerifier(uint256 _n, uint256 _m, address _addr, bytes4 _sel) external {
        bytes32 key = keccak256(abi.encode(_n, _m));
        _verifiers[key] = IPoolVaultPP.Verifier({addr: _addr, selector: _sel});
    }

    function isKnownRoot(uint256 _root) external view returns (bool) {
        return knownRoots[_root];
    }

    function keystore() external view returns (IKeystorePP) {
        return keystoreAddr;
    }

    function aspRegistry() external view returns (IASPRegistryPP) {
        return aspRegistryAddr;
    }

    function verifiers(bytes32 _key) external view returns (IPoolVaultPP.Verifier memory) {
        return _verifiers[_key];
    }
}

contract MockKeystore {
    mapping(uint256 => bool) public knownRoots;

    function setKnownRoot(uint256 _root, bool _known) external {
        knownRoots[_root] = _known;
    }

    function isKnownRoot(uint256 _root) external view returns (bool) {
        return knownRoots[_root];
    }
}

contract MockASPRegistry {
    uint256 public root;

    function setLatestASPRoot(uint256 _root) external {
        root = _root;
    }

    function latestASPRoot() external view returns (uint256) {
        return root;
    }
}

contract MockEntrypointPP {
    mapping(address => IEntrypointPP.AssetConfig) public _assets;

    function setAsset(address _asset, uint256 _maxRelayFee) external {
        _assets[_asset] = IEntrypointPP.AssetConfig({
            enabled: true,
            minAmount: 0,
            vettingFeeBPS: 0,
            maxRelayFee: _maxRelayFee
        });
    }

    function assets(address _asset) external view returns (IEntrypointPP.AssetConfig memory) {
        return _assets[_asset];
    }
}

/// @dev Returns true for any proof.
contract MockVerifier {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

/// @dev Returns false for any proof.
contract MockBadVerifier {
    fallback() external {
        assembly {
            mstore(0, 0)
            return(0, 32)
        }
    }
}

// ----- Test contract -----

contract PrivacyPoolsAccountTest is Test {
    PrivacyPoolsAccount internal account;
    MockRelay internal relay;
    MockPoolVault internal poolVault;
    MockKeystore internal keystore;
    MockASPRegistry internal aspRegistry;
    MockEntrypointPP internal ppEntrypoint;
    MockVerifier internal verifier;

    address internal paymaster = address(0x0A1);
    address internal recipient = address(0xBEEF);
    address internal entryPointAddr = address(0x4337);

    // Default proof values.
    uint256 constant STATE_ROOT = 111;
    uint256 constant KEYSTORE_ROOT = 222;
    uint256 constant ASP_ROOT = 333;
    uint256 constant AMOUNT_OUT = 1 ether;
    uint256 constant FEE_AMOUNT = 0.01 ether;
    uint256 constant NULLIFIER_1 = 0xDEAD;
    uint256 constant COMMITMENT_1 = 0xBEEF;
    address constant FEE_TOKEN = address(0x1234); // ERC20

    function setUp() public {
        poolVault = new MockPoolVault();
        keystore = new MockKeystore();
        aspRegistry = new MockASPRegistry();
        ppEntrypoint = new MockEntrypointPP();
        verifier = new MockVerifier();

        poolVault.setKeystore(IKeystorePP(address(keystore)));
        poolVault.setAspRegistry(IASPRegistryPP(address(aspRegistry)));

        relay = new MockRelay(
            IPoolVaultPP(address(poolVault)),
            IEntrypointPP(address(ppEntrypoint))
        );

        account = new PrivacyPoolsAccount(
            IEntryPoint(entryPointAddr),
            IPrivacyPoolRelay(address(relay))
        );

        // Set up default valid state.
        poolVault.setKnownRoot(STATE_ROOT, true);
        keystore.setKnownRoot(KEYSTORE_ROOT, true);
        aspRegistry.setLatestASPRoot(ASP_ROOT);
        ppEntrypoint.setAsset(FEE_TOKEN, 0.1 ether);
        ppEntrypoint.setAsset(ConstantsPP.NATIVE_ASSET, 0.1 ether);

        // Register verifier for 1x1 circuit (1 nullifier, 1 commitment).
        poolVault.setVerifier(1, 1, address(verifier), bytes4(0x12345678));
    }

    // ----- Helpers -----

    struct ProofParams {
        uint256 amountOut;
        address tokenIdOut;
        uint256 stateRoot;
        uint256 keystoreRoot;
        uint256 aspRoot;
        uint256 context;
        uint256[] nullifiers;
        uint256[] commitments;
    }

    function _defaultProofParams() internal pure returns (ProofParams memory p) {
        p.amountOut = AMOUNT_OUT;
        p.tokenIdOut = FEE_TOKEN;
        p.stateRoot = STATE_ROOT;
        p.keystoreRoot = KEYSTORE_ROOT;
        p.aspRoot = ASP_ROOT;
        p.nullifiers = new uint256[](1);
        p.nullifiers[0] = NULLIFIER_1;
        p.commitments = new uint256[](1);
        p.commitments[0] = COMMITMENT_1;
        // context will be computed later
    }

    function _buildProof(ProofParams memory p) internal pure returns (ProofLibV2.TransactProof memory proof) {
        proof.pubSignals = new uint256[][](8);
        proof.pubSignals[0] = p.nullifiers;
        proof.pubSignals[1] = p.commitments;

        proof.pubSignals[2] = new uint256[](1);
        proof.pubSignals[2][0] = p.stateRoot;

        proof.pubSignals[3] = new uint256[](1);
        proof.pubSignals[3][0] = p.keystoreRoot;

        proof.pubSignals[4] = new uint256[](1);
        proof.pubSignals[4][0] = p.aspRoot;

        proof.pubSignals[5] = new uint256[](1);
        proof.pubSignals[5][0] = p.amountOut;

        proof.pubSignals[6] = new uint256[](1);
        proof.pubSignals[6][0] = uint256(uint160(p.tokenIdOut));

        proof.pubSignals[7] = new uint256[](1);
        proof.pubSignals[7][0] = p.context;
    }

    function _defaultPayout() internal view returns (IPrivacyPoolRelay.PayoutRouting memory) {
        return IPrivacyPoolRelay.PayoutRouting({
            recipient: recipient,
            feeRecipient: paymaster,
            feeAmount: FEE_AMOUNT,
            nativeGas: 0
        });
    }

    /// @dev Builds valid feeCalldata with correct context binding.
    function _buildFeeCalldata(
        ProofParams memory pp,
        IPrivacyPoolRelay.PayoutRouting memory payout
    ) internal view returns (bytes memory) {
        IPoolVaultPP.TransactParams memory transactParams = IPoolVaultPP.TransactParams({
            processor: address(relay),
            data: abi.encode(payout)
        });

        IPoolVaultPP.NoteData[] memory noteData = new IPoolVaultPP.NoteData[](1);
        noteData[0] = IPoolVaultPP.NoteData({hint: bytes32(0), data: ""});

        // Compute context binding.
        pp.context = uint256(keccak256(abi.encode(transactParams, noteData))) % ConstantsPP.SNARK_SCALAR_FIELD;

        ProofLibV2.TransactProof memory proof = _buildProof(pp);

        return abi.encodeWithSelector(
            IPrivacyPoolRelay.relay.selector,
            proof,
            transactParams,
            noteData
        );
    }

    function _validFeeCalldata() internal view returns (bytes memory) {
        return _buildFeeCalldata(_defaultProofParams(), _defaultPayout());
    }

    function _callPreviewFee(bytes memory feeCalldata) internal {
        vm.prank(paymaster);
        account.previewFee(feeCalldata, "");
    }

    function _callPreviewFeeExpectReturn(
        bytes memory feeCalldata,
        address expectedToken,
        uint256 expectedFee
    ) internal {
        vm.prank(paymaster);
        (address token, uint256 fee) = account.previewFee(feeCalldata, "");
        assertEq(token, expectedToken);
        assertEq(fee, expectedFee);
    }

    // ============================
    // ===== HAPPY PATH TESTS =====
    // ============================

    function test_previewFee_validWithdrawal() public {
        _callPreviewFeeExpectReturn(_validFeeCalldata(), FEE_TOKEN, FEE_AMOUNT);
    }

    function test_previewFee_validTransfer() public {
        // Transfer: feeAmount == amountOut (full withdrawal is fee).
        ProofParams memory pp = _defaultProofParams();
        pp.amountOut = FEE_AMOUNT; // amountOut == feeAmount

        IPrivacyPoolRelay.PayoutRouting memory payout = _defaultPayout();
        payout.feeAmount = FEE_AMOUNT;

        _callPreviewFeeExpectReturn(
            _buildFeeCalldata(pp, payout),
            FEE_TOKEN,
            FEE_AMOUNT
        );
    }

    function test_previewFee_nativeAssetMapping() public {
        // PP v2 NATIVE_ASSET sentinel should map to address(0).
        ProofParams memory pp = _defaultProofParams();
        pp.tokenIdOut = ConstantsPP.NATIVE_ASSET;

        _callPreviewFeeExpectReturn(
            _buildFeeCalldata(pp, _defaultPayout()),
            address(0),
            FEE_AMOUNT
        );
    }

    // =============================
    // ===== VALIDATION TESTS ======
    // =============================

    function test_previewFee_invalidSelector() public {
        bytes memory bad = abi.encodeWithSelector(bytes4(0xDEADBEEF), uint256(0));
        vm.prank(paymaster);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolsAccount.InvalidSelector.selector, bytes4(0xDEADBEEF)));
        account.previewFee(bad, "");
    }

    function test_previewFee_invalidProcessor() public {
        ProofParams memory pp = _defaultProofParams();
        IPrivacyPoolRelay.PayoutRouting memory payout = _defaultPayout();

        IPoolVaultPP.TransactParams memory transactParams = IPoolVaultPP.TransactParams({
            processor: address(0xBAD), // wrong processor
            data: abi.encode(payout)
        });

        IPoolVaultPP.NoteData[] memory noteData = new IPoolVaultPP.NoteData[](1);
        noteData[0] = IPoolVaultPP.NoteData({hint: bytes32(0), data: ""});

        pp.context = uint256(keccak256(abi.encode(transactParams, noteData))) % ConstantsPP.SNARK_SCALAR_FIELD;
        ProofLibV2.TransactProof memory proof = _buildProof(pp);

        bytes memory feeCalldata = abi.encodeWithSelector(
            IPrivacyPoolRelay.relay.selector, proof, transactParams, noteData
        );

        vm.prank(paymaster);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolsAccount.InvalidProcessor.selector, address(0xBAD)));
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_invalidFeeRecipient() public {
        IPrivacyPoolRelay.PayoutRouting memory payout = _defaultPayout();
        payout.feeRecipient = address(0xBAD);

        bytes memory feeCalldata = _buildFeeCalldata(_defaultProofParams(), payout);

        vm.prank(paymaster);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolsAccount.InvalidFeeRecipient.selector, address(0xBAD)));
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_nonZeroNativeGas() public {
        IPrivacyPoolRelay.PayoutRouting memory payout = _defaultPayout();
        payout.nativeGas = 1;

        bytes memory feeCalldata = _buildFeeCalldata(_defaultProofParams(), payout);

        vm.prank(paymaster);
        vm.expectRevert(PrivacyPoolsAccount.NonZeroNativeGas.selector);
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_zeroFee() public {
        IPrivacyPoolRelay.PayoutRouting memory payout = _defaultPayout();
        payout.feeAmount = 0;

        bytes memory feeCalldata = _buildFeeCalldata(_defaultProofParams(), payout);

        vm.prank(paymaster);
        vm.expectRevert(PrivacyPoolsAccount.ZeroFee.selector);
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_zeroAmountOut() public {
        ProofParams memory pp = _defaultProofParams();
        pp.amountOut = 0;

        bytes memory feeCalldata = _buildFeeCalldata(pp, _defaultPayout());

        vm.prank(paymaster);
        vm.expectRevert(PrivacyPoolsAccount.ZeroAmountOut.selector);
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_feeExceedsAmountOut() public {
        ProofParams memory pp = _defaultProofParams();
        pp.amountOut = FEE_AMOUNT - 1; // less than fee

        bytes memory feeCalldata = _buildFeeCalldata(pp, _defaultPayout());

        vm.prank(paymaster);
        vm.expectRevert(
            abi.encodeWithSelector(PrivacyPoolsAccount.FeeExceedsAmountOut.selector, FEE_AMOUNT, FEE_AMOUNT - 1)
        );
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_contextMismatch() public {
        ProofParams memory pp = _defaultProofParams();
        pp.context = 999; // wrong context

        ProofLibV2.TransactProof memory proof = _buildProof(pp);

        IPoolVaultPP.TransactParams memory transactParams = IPoolVaultPP.TransactParams({
            processor: address(relay),
            data: abi.encode(_defaultPayout())
        });

        IPoolVaultPP.NoteData[] memory noteData = new IPoolVaultPP.NoteData[](1);
        noteData[0] = IPoolVaultPP.NoteData({hint: bytes32(0), data: ""});

        bytes memory feeCalldata = abi.encodeWithSelector(
            IPrivacyPoolRelay.relay.selector, proof, transactParams, noteData
        );

        vm.prank(paymaster);
        vm.expectRevert(); // ContextMismatch
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_feeExceedsMaxRelayFee() public {
        // Set maxRelayFee lower than fee amount.
        ppEntrypoint.setAsset(FEE_TOKEN, FEE_AMOUNT - 1);

        bytes memory feeCalldata = _validFeeCalldata();

        vm.prank(paymaster);
        vm.expectRevert(
            abi.encodeWithSelector(PrivacyPoolsAccount.FeeExceedsMaxRelayFee.selector, FEE_AMOUNT, FEE_AMOUNT - 1)
        );
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_spentNullifier() public {
        poolVault.setSpentNullifier(NULLIFIER_1, block.timestamp);

        bytes memory feeCalldata = _validFeeCalldata();

        vm.prank(paymaster);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolsAccount.NullifierAlreadySpent.selector, NULLIFIER_1));
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_unknownStateRoot() public {
        poolVault.setKnownRoot(STATE_ROOT, false);

        bytes memory feeCalldata = _validFeeCalldata();

        vm.prank(paymaster);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolsAccount.UnknownStateRoot.selector, STATE_ROOT));
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_unknownKeystoreRoot() public {
        keystore.setKnownRoot(KEYSTORE_ROOT, false);

        bytes memory feeCalldata = _validFeeCalldata();

        vm.prank(paymaster);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolsAccount.UnknownKeystoreRoot.selector, KEYSTORE_ROOT));
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_invalidASPRoot() public {
        aspRegistry.setLatestASPRoot(999);

        bytes memory feeCalldata = _validFeeCalldata();

        vm.prank(paymaster);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolsAccount.InvalidASPRoot.selector, ASP_ROOT, 999));
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_unsupportedCircuit() public {
        // Use 2 nullifiers, no verifier registered for 2x1.
        ProofParams memory pp = _defaultProofParams();
        pp.nullifiers = new uint256[](2);
        pp.nullifiers[0] = 0xDEAD;
        pp.nullifiers[1] = 0xBEEF;

        bytes memory feeCalldata = _buildFeeCalldata(pp, _defaultPayout());

        vm.prank(paymaster);
        vm.expectRevert(abi.encodeWithSelector(PrivacyPoolsAccount.UnsupportedCircuit.selector, 2, 1));
        account.previewFee(feeCalldata, "");
    }

    function test_previewFee_invalidProof() public {
        // Replace verifier with one that returns false.
        MockBadVerifier badVerifier = new MockBadVerifier();
        poolVault.setVerifier(1, 1, address(badVerifier), bytes4(0x12345678));

        bytes memory feeCalldata = _validFeeCalldata();

        vm.prank(paymaster);
        vm.expectRevert(PrivacyPoolsAccount.ProofVerificationFailed.selector);
        account.previewFee(feeCalldata, "");
    }
}
