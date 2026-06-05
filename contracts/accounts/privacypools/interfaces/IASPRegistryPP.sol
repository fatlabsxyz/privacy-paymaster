// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal vendored interface for Privacy Pools v2 ASPRegistry.
interface IASPRegistryPP {
    function latestASPRoot() external view returns (uint256 _root);
}
