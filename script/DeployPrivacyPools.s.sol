// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Deployments} from "./lib/Deployments.sol";
import {Chains} from "./lib/Chains.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PrivacyPaymaster} from "../contracts/PrivacyPaymaster.sol";
import {PrivacyPoolsAccount} from "../contracts/accounts/privacypools/PrivacyPoolsAccount.sol";
import {IPrivacyPoolRelay} from "../contracts/accounts/privacypools/interfaces/IPrivacyPoolRelay.sol";

contract DeployPrivacyPools is Script {
    function run() external {
        address paymasterAddr = Deployments.readAddress("paymaster", "address");
        PrivacyPaymaster paymaster = PrivacyPaymaster(payable(paymasterAddr));
        IEntryPoint entryPoint = paymaster.entryPoint();

        address relayAddr = Chains.readAddress("protocols.privacypools", "relay");
        IPrivacyPoolRelay relay = IPrivacyPoolRelay(relayAddr);

        uint256 privateKey = vm.envUint("PRIVATE_KEY");

        vm.broadcast(privateKey);
        PrivacyPoolsAccount account = new PrivacyPoolsAccount(entryPoint, relay);

        vm.broadcast(privateKey);
        paymaster.setApprovedImpl(address(account), true);

        console.log("Deployed PrivacyPoolsAccount at: %s", address(account));
        Deployments.writeAddress("privacypools", "privacyPoolsAccount", address(account));
    }
}
