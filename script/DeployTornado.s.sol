// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Deployments} from "./lib/Deployments.sol";
import {Chains} from "./lib/Chains.sol";

import {
    IEntryPoint
} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PrivacyPaymaster} from "../contracts/PrivacyPaymaster.sol";
import {
    TornadoAccount
} from "../contracts/accounts/tornadocash/TornadoAccount.sol";
import {
    ITornadoInstance
} from "../contracts/accounts/tornadocash/interfaces/ITornadoInstance.sol";
import {
    IUniswapV3Pool
} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

contract DeployTornado is Script {
    function run() external {
        address paymasterAddr = Deployments.readAddress("paymaster", "address");

        uint256 privateKey = vm.envUint("PRIVATE_KEY");

        address deployment_eth_1 = deploy(
            paymasterAddr,
            "protocols.tornado.eth_1",
            privateKey
        );
        console.log("Deployed TornadoAccount (1 ETH) at:", deployment_eth_1);
        Deployments.writeAddress("tornado_1", "tornadoAccount", deployment_eth_1);

        address deployment_eth_0_1 = deploy(
            paymasterAddr,
            "protocols.tornado.eth_0_1",
            privateKey
        );
        console.log("Deployed TornadoAccount (0.1 ETH) at:", deployment_eth_0_1);
        Deployments.writeAddress("tornado_0_1", "tornadoAccount", deployment_eth_0_1);

        address deployment_dai_100 = deploy(
            paymasterAddr,
            "protocols.tornado.dai_100",
            privateKey
        );
        console.log("Deployed TornadoAccount (100 DAI) at:", deployment_dai_100);
        Deployments.writeAddress("tornado_d_100", "tornadoAccount", deployment_dai_100);

    }

    function deploy(
        address paymasterAddr,
        string memory tornadoProtocolTomlKey,
        uint256 privateKey
    ) public returns (address) {
        PrivacyPaymaster paymaster = PrivacyPaymaster(payable(paymasterAddr));
        IEntryPoint entryPoint = paymaster.entryPoint();
        address tornadoInstanceAddr = Chains.readAddress(
            tornadoProtocolTomlKey,
            "instance"
        );
        ITornadoInstance tornadoInstance = ITornadoInstance(
            tornadoInstanceAddr
        );

        vm.broadcast(privateKey);
        TornadoAccount tornadoAccount = new TornadoAccount(
            entryPoint,
            tornadoInstance
        );
        vm.broadcast(privateKey);
        paymaster.setApprovedImpl(address(tornadoAccount), true);

        address feeToken = tornadoAccount.FEE_TOKEN();
        (bool allowed, ) = paymaster.feeTokens(feeToken);
        if (feeToken != address(0) && !allowed) {
            uint24 uniswapFee = uint24(Chains.readUint(
                tornadoProtocolTomlKey,
                "uniswap_fee"
            ));
            vm.broadcast(privateKey);
            paymaster.setFeeToken(feeToken, uniswapFee, true);

            // Expand pool observation buffer to cover the TWAP period
            uint32 twapPeriod = paymaster.twapPeriod();
            uint32 blockTime = uint32(Chains.readUint("block_time"));
            uint16 requiredCardinality = uint16(twapPeriod / blockTime) + 1;
            address pool = paymaster.FACTORY().getPool(feeToken, paymaster.WETH(), uniswapFee);
            vm.broadcast(privateKey);
            IUniswapV3Pool(pool).increaseObservationCardinalityNext(requiredCardinality);
        }

        return address(tornadoAccount);
    }
}
