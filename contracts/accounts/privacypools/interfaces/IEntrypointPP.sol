// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal vendored interface for Privacy Pools v2 Entrypoint.
interface IEntrypointPP {
    struct AssetConfig {
        bool enabled;
        uint256 minAmount;
        uint256 vettingFeeBPS;
        uint256 maxRelayFee;
    }

    function assets(address _asset) external view returns (AssetConfig memory _config);
}
