// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface ITornadoInstance {

    function verifier() external view returns (address);
    function deposit(bytes32 _commitment) external payable;
    function isKnownRoot(bytes32 _root) external view returns (bool);
    function denomination() external view returns (uint256);
    function nullifierHashes(bytes32 _nullifierHash) external view returns (bool);
    function isSpent(bytes32 _nullifierHash) external view returns (bool);
    function isSpentArray(bytes32[] calldata _nullifierHashes) external view returns (bool[] memory spent);
    function withdraw(
        bytes calldata _proof,
        bytes32 _root,
        bytes32 _nullifierHash,
        address payable _recipient,
        address payable _relayer,
        uint256 _fee,
        uint256 _refund
    ) external;

    function roots(uint256 index) external view returns (bytes32);
    function ROOT_HISTORY_SIZE() external view returns (uint32);
    function currentRootIndex() external view returns (uint32);
    function nextIndex() external view returns (uint32);
    function getLastRoot() external view returns (bytes32);
    event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp);
    event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee);
}
