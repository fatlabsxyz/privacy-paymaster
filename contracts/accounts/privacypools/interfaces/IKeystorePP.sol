// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal vendored interface for Privacy Pools v2 Keystore.
interface IKeystorePP {
    function isKnownRoot(uint256 _root) external view returns (bool _isKnown);
}
