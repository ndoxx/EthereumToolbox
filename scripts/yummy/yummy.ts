const chalk = require('chalk');
const https = require('https');
import { ethers } from "ethers";
import * as fs from 'fs';
import * as path from 'path';

import Pair from '@uniswap/v2-core/build/UniswapV2Pair.json';
import UniswapV2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json';
import UniswapV2Router from '@uniswap/v2-periphery/build/UniswapV2Router02.json';

import { fetchContractByAddress } from '../common/contract-utils'

const EPSILON = ethers.utils.parseEther('0.0001');
const GAS_LIMIT = 250000;

function clamp(
	a: number,
	min: number,
	max: number
) {
	return Math.max(min, Math.min(a, max));
}

async function wait(
	provider: any,
	hash: string,
	desc?: string,
	confirmation: number = 1
): Promise<void> {
	if (desc) {
		console.log(`> Waiting tx ${hash}\n    action = ${desc}`);
	} else {
		console.log(`> Waiting tx ${hash}`);
	}
	await provider.waitForTransaction(hash, confirmation);
}

function printBalance(
	address: string,
	etherBalance: ethers.BigNumber,
	etherSymbol: string,
	tokenBalance: ethers.BigNumber,
	tokenSymbol: string
) {
	console.log(`Wallet ${address} balance:`);

	const balanceInfo = [
		[etherSymbol, ethers.utils.formatEther(etherBalance)],
		[tokenSymbol, ethers.utils.formatEther(tokenBalance)]
	];
	console.table(balanceInfo);
}



async function main() {
	let tx;

	console.log(chalk.cyanBright.underline.bold("### YUMMY::AUTO-COMPOUND ###"));
	const config = require(path.join(__dirname, "../../config/yummy.json"));
	const configCommon = require(path.join(__dirname, "../../config/common.json"));
	const secrets = require(path.join(__dirname, "../../config/secrets.json"));

	let SLIPPAGE_TOLERANCE = clamp(config.global.slippageTolerance, 0, 1);

	// TODO: parameterize this
	const pool = config.pools[0];


	console.log(`Pool: ${pool.name}`);

	if(pool.hasOwnProperty('slippageTolerance')) {
		SLIPPAGE_TOLERANCE = clamp(pool.slippageTolerance, 0, 1);
	}

	let f0 = 0;
	if(pool.hasOwnProperty('profitFraction')) {
		f0 = clamp(pool.profitFraction, 0, 1);
	}
	const SWAP_FRACTION = ethers.BigNumber.from(Math.floor(0.5 * (1 + f0) * 10000));
	const LIQUIDITY_ETHER_FRACTION = ethers.BigNumber.from(Math.floor((1 - f0) / (1 + f0) * 10000));

	// Connect to network
	console.log(chalk.yellow(`Connecting to network: ${pool.network}`));
	const networkInfo = configCommon.networks[pool.network];
	const provider = new ethers.providers.JsonRpcProvider(networkInfo.url);
	const network = await provider.getNetwork();
	// Check chainId
	if(network.chainId != networkInfo.chainId) {
		throw new Error(chalk.red(`Invalid chainId: got ${networkInfo.chainId}, expected ${network.chainId}`));
	}

	// Connect wallet
	const privateKey = secrets[pool.network].privateKey;
	const wallet = new ethers.Wallet(privateKey, provider);

	// Get token & farm contracts
	const apiKey = secrets[pool.network].scanAPIKey;
	const token = await fetchContractByAddress(pool.token, networkInfo, apiKey, provider);
	const farm = await fetchContractByAddress(pool.farm, networkInfo, apiKey, provider);

	const etherSymbol = networkInfo.symbol;
	const tokenSymbol = await token.symbol();

	// Get DEX
	const DEXInfo = networkInfo.DEX[pool.DEX];
	const router = new ethers.Contract(DEXInfo.router, UniswapV2Router.abi, provider);
	const factoryAddress = await router.factory();
	const factory = new ethers.Contract(factoryAddress, UniswapV2Factory.abi, provider);

	const WETH = await router.WETH();
	const LP = await factory.getPair(token.address, WETH);
	const pair = new ethers.Contract(LP, Pair.abi, provider);
	const DEXLPSymbol = await pair.symbol();
	const WETHSymbol = `W${etherSymbol}`;
	const LPSymbol = `[${WETHSymbol}]-[${tokenSymbol}]_${DEXLPSymbol}`;


	// Display wallet balance
	const initialEtherBalance = await wallet.getBalance();
	const initialTokenBalance = await token.balanceOf(wallet.address);

	printBalance(
		wallet.address,
		initialEtherBalance,
		etherSymbol,
		initialTokenBalance,
		tokenSymbol
	);


	// ### INFO ###
	// Get pair reserves and estimate token price
	let etherReserve, tokenReserve;
	const reserves = await pair.getReserves();
	const token0 = await pair.token0();
	if(token0 == WETH) {
		etherReserve = reserves[0];
		tokenReserve = reserves[1];
	}
	else {
		etherReserve = reserves[1];
		tokenReserve = reserves[0];
	}

	etherReserve = parseFloat(ethers.utils.formatEther(etherReserve));
	tokenReserve = parseFloat(ethers.utils.formatEther(tokenReserve));
	const tokenPrice = etherReserve / tokenReserve;

	const displayInfo = [
		[`${WETHSymbol} address`, WETH],
		[`${LPSymbol} address`, LP],
		[`${etherSymbol} reserve`, etherReserve],
		[`${tokenSymbol} reserve`, tokenReserve],
		[`${tokenSymbol} price`, `${tokenPrice} ${etherSymbol}`]
	];
	console.table(displayInfo);


	// ### HARVEST ###
	console.log(chalk.yellow("* Harvesting rewards"));
	tx = await farm.connect(wallet).withdraw(pool.pid, 0, { gasLimit: GAS_LIMIT });
	await wait(provider, tx.hash, "farm.withdraw");

	const afterClaimEtherBalance = await wallet.getBalance();
	const afterClaimTokenBalance = await token.balanceOf(wallet.address);
	const claimedTokens = afterClaimTokenBalance.sub(initialTokenBalance);

	console.log(chalk.green(`Received ${ethers.utils.formatEther(claimedTokens)} ${tokenSymbol}`));


	// ### SWAP ###
	// Swap half of token balance for ether
	console.log(chalk.yellow(`* Swapping tokens`));
	const tokensToSwap = afterClaimTokenBalance.mul(SWAP_FRACTION).div(10000);
	const amount = parseFloat(ethers.utils.formatEther(tokensToSwap));
	const amountOutMin = ethers.utils.parseEther((amount * tokenPrice * (1 - SLIPPAGE_TOLERANCE)).toString());
	
	console.log(`Swapping ${ethers.utils.formatEther(tokensToSwap)} ${tokenSymbol} for at least ${ethers.utils.formatEther(amountOutMin)} ${etherSymbol}`);

	// Approval: all claimed tokens are spent by router, during swap and then when adding liquidity
	tx = await token.connect(wallet).approve(router.address, afterClaimTokenBalance); 
	await wait(provider, tx.hash, `${tokenSymbol}.approve`);

	// Swap
	if(!pool.hasFees) {
		tx = await router.connect(wallet).swapExactTokensForETH(
			tokensToSwap,
			amountOutMin,
			[token.address, WETH],
			wallet.address,
			Math.floor(Date.now() / 1000) + 100,
			{
				gasLimit: GAS_LIMIT
			}
		);
		await wait(provider, tx.hash, `router.swapExactTokensForETH`);
	}
	else {
		tx = await router.connect(wallet).swapExactTokensForETHSupportingFeeOnTransferTokens(
			tokensToSwap,
			amountOutMin,
			[token.address, WETH],
			wallet.address,
			Math.floor(Date.now() / 1000) + 100,
			{
				gasLimit: GAS_LIMIT
			}
		);
		await wait(provider, tx.hash, `router.swapExactTokensForETHSupportingFeeOnTransferTokens`);
	}

	const afterSwapEtherBalance = await wallet.getBalance();
	const afterSwapTokenBalance = await token.balanceOf(wallet.address);

	if(afterSwapEtherBalance < afterClaimEtherBalance) {
		throw new Error(chalk.red('Swap failed'));
	}

	// Retrieve ether amount
	const ethReceived = afterSwapEtherBalance.sub(afterClaimEtherBalance);
	console.log(chalk.green(`Received ${ethers.utils.formatEther(ethReceived)} ${etherSymbol}`));


	// If afterSwapTokenBalance is null, we got everything out for profit, so there is nothing left to compound
	if(afterSwapTokenBalance <= EPSILON) {
		console.log(chalk.yellow("Nothing left to compound"));
		return;
	}

	// ### LIQUIDITY ###
	console.log(chalk.yellow("* Adding liquidity"));

	const ethLiquidityAmount = ethReceived.mul(LIQUIDITY_ETHER_FRACTION).div(10000);
	const tokLiquidityAmount = afterSwapTokenBalance.sub(EPSILON);
	console.log(`Composition: (${ethers.utils.formatEther(tokLiquidityAmount)} ${tokenSymbol}, ${ethers.utils.formatEther(ethLiquidityAmount)} ${etherSymbol})`);

	const SLIPPAGE_FACTOR = ethers.BigNumber.from((1 - SLIPPAGE_TOLERANCE) * 10000);
	tx = await router.connect(wallet).addLiquidityETH(
		token.address,
		tokLiquidityAmount, 					            // desired tokens
		tokLiquidityAmount.mul(SLIPPAGE_FACTOR).div(10000), // min tokens
		ethLiquidityAmount.mul(SLIPPAGE_FACTOR).div(10000), // min eth
		wallet.address,
		Math.floor(Date.now() / 1000) + 100,                // deadline
		{
			value: ethLiquidityAmount,
			gasLimit: GAS_LIMIT
		}
	);
	await wait(provider, tx.hash, `router.addLiquidityETH`);

	// Get LP balance
	const LPBalance = await pair.balanceOf(wallet.address);

	console.log(chalk.green(`Received ${ethers.utils.formatEther(LPBalance)} ${LPSymbol}`));
	

	// ### RESTAKE ###
	console.log(chalk.yellow(`* Staking all LPs`));

	// Stake whole LP balance in pool
	tx = await pair.connect(wallet).approve(farm.address, LPBalance); 
	await wait(provider, tx.hash, `LPToken.approve`);

	// tx = await farm.connect(wallet).deposit(pool.pid, LPBalance); // DNW (farm.connect(wallet).deposit is not a function)
	tx = await farm.connect(wallet).functions['deposit(uint256,uint256)'](pool.pid, LPBalance);
	await wait(provider, tx.hash, `farm.deposit`);


	const afterStakeEtherBalance = await wallet.getBalance();
	const afterStakeTokenBalance = await token.balanceOf(wallet.address);

	printBalance(
		wallet.address,
		afterStakeEtherBalance,
		etherSymbol,
		afterStakeTokenBalance,
		tokenSymbol
	);
}

main();