// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Constants vendored from Privacy Pools v2.
library ConstantsPP {
    /// @notice Sentinel address representing native ETH in Privacy Pools v2.
    address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice BN254 scalar field size used for context hashing.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
}
