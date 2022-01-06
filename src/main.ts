import beeper from 'beeper';
import Web3 from 'web3';
import log from 'simple-node-logger';
import { cts } from './utils/constants.js';
import { Marketplace } from './Marketplace.js';
import { Wallet } from './Wallet.js';
import { WalletWatcher } from './WalletWatcher.js';
import { CoinWatcher } from './CoinWatcher.js';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

function setupLogger() {
	const logDirectory = './logs';
	if (!fs.existsSync(logDirectory)) {
		fs.mkdirSync(logDirectory);
	}

	const logger = log.createRollingFileLogger({
		errorEventName: 'error',
		logDirectory,
		fileNamePattern: 'thetans-<DATE>.log',
		timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
	});
	return logger;
}

async function main() {
	console.log('Starting...');

	const earnExpectPercentage = parseFloat(process.argv[2]) || 0.5;
	console.log('Earn expect percentage: ' + earnExpectPercentage);

	const web3 = new Web3(process.env.BSC_PROVIDER || 'https://data-seed-prebsc-1-s1.binance.org:8545');
	const wallet = new Wallet(web3);

	const walletWatcher = new WalletWatcher(wallet);
	await walletWatcher.start();

	const coinWatcher = new CoinWatcher();
	await coinWatcher.start();

	const marketplace = new Marketplace(web3, wallet);
	await marketplace.connect();

	await tradeRoutine(wallet, walletWatcher, coinWatcher, marketplace, earnExpectPercentage);
}

async function tradeRoutine(
	wallet: Wallet,
	walletWatcher: WalletWatcher,
	coinWatcher: CoinWatcher,
	marketplace: Marketplace,
	earnExpectPercentage: number
) {
	let lastGoodThetansIds: any[] = [];

	async function getBestThetans(thetans: any[]) {
		let bestThetans = thetans;
		if (!bestThetans || bestThetans?.length === 0) {
			console.log('Waiting for thetans...');
			return [];
		}
		if (!coinWatcher.coins.BNB || !coinWatcher.coins.THC) {
			console.log('Waiting for coin prices...');
			return [];
		}

		// *All thetans*
		// console.log('Thetans number: ' + bestThetans.length);

		// *Non sold*
		// bestThetans = bestThetans.filter((hero) => hero.onMarketTime !== 0);
		// console.log('Thetans number (non sold): ' + bestThetans.length);

		// *Min and Max price filter*
		bestThetans = bestThetans.filter(
			(hero) => hero.price / 1e8 >= cts.MIN_THETAN_PRICE_WBNB && hero.price / 1e8 <= cts.MAX_THETAN_PRICE_WBNB
		);

		// *Price lower than my WBNB balance*
		bestThetans = bestThetans.filter((hero) => hero.price / 1e8 < walletWatcher.balance.WBNB);
		console.log(`Thetans number (less than ${walletWatcher.balance.WBNB} WBNB): ${bestThetans.length}`);

		// *Earn potential percentage higher than earnExpectPercentage*
		bestThetans = bestThetans.filter((hero, index) => {
			const earnPotential =
				hero.battleCap *
				coinWatcher.coins.THC *
				cts.BATTLE_WIN_RATE *
				cts.THETAN_RARITY_WIN_REWARDS_PER_BATTLE_THC[hero.heroRarity];
			const earnRate = (earnPotential * 1e8) / (hero.price * coinWatcher.coins.BNB) - 1;

			if (earnRate >= earnExpectPercentage) {
				bestThetans[index].earnPotentialDollar = earnPotential.toFixed(2);
				bestThetans[index].earnRatePercentage = (earnRate * 100).toFixed(2);
				bestThetans[index].heroPriceDollar = ((hero.price * coinWatcher.coins.BNB) / 1e8).toFixed(2);
			}
			return earnRate >= earnExpectPercentage;
		});
		console.log(`Thetans number (good earn potential): ${bestThetans.length}`);

		// *Remove unwanted thetans*
		bestThetans = bestThetans.filter((hero) => {
			// Increase difficulty of getting shitty Veinkas
			if (hero.name === 'Veinka' && hero.earnRatePercentage < earnExpectPercentage * 1.5) {
				return false;
			}
			return hero;
		});

		return bestThetans;
	}

	function filterAlreadyListedThetans(bestThetans: any[]) {
		for (let i = 0; i < bestThetans.length; i++) {
			if (lastGoodThetansIds.includes(bestThetans[i].id)) {
				bestThetans.splice(i, 1);
				i--;
			}
		}
		return bestThetans;
	}

	function orderThetansByEarnRate(bestThetans: any[]) {
		return bestThetans.sort((a, b) => b.earnRatePercentage - a.earnRatePercentage);
	}

	async function verifyBalances(bestThetans: any[]) {
		if (walletWatcher.balance.WBNB < bestThetans[0].price / 1e8) {
			console.log('Not enough WBNB balance! Updating balance...');
			walletWatcher.update();
			beeper(1);
			return false;
		}
		if (walletWatcher.balance.BNB < cts.MARKETPLACE_MAX_GAS_PRICE * cts.MARKETPLACE_BUY_GAS * 1e-9) {
			const buyAmount = cts.MARKETPLACE_MAX_GAS_PRICE * cts.MARKETPLACE_BUY_GAS * 1e-9 * 2;
			logger.warn(`Not enough BNB balance, buying ${buyAmount} BNB!`);
			await wallet.unwrapBNB(buyAmount);
			beeper(1);
			return false;
		}
		return true;
	}

	function logBestThetans(bestThetans: any[]) {
		bestThetans.forEach((hero) => {
			logger.info(
				`${hero.name}(${hero.id.slice(0, 8)}):
	Current Time: ${new Date(Date.now()).toLocaleString()}
	Price: $${hero.heroPriceDollar}
	Earn Potential: $${hero.earnPotentialDollar}
	Earn Rate: ${hero.earnRatePercentage}%
	Link: https://marketplace.thetanarena.com/item/${hero.refId}`
			);
		});
	}

	while (true) {
		const thetans = await marketplace.getThetans();
		let bestThetans = await getBestThetans(thetans);
		bestThetans = filterAlreadyListedThetans(bestThetans);
		bestThetans = orderThetansByEarnRate(bestThetans);
		if (bestThetans && bestThetans.length > 0) {
			const isBalanceValid = await verifyBalances(bestThetans);
			if (!isBalanceValid) continue;

			const result = await marketplace.buyThetan(
				bestThetans[0].id,
				bestThetans[0].tokenId,
				bestThetans[0].price,
				bestThetans[0].ownerAddress
			);
			if (result.status === 'error') {
				logger.error(
					`Error buying thetan ${result.thetanId} for ${result.thetanPrice} WBNB: ${result.message}`
				);
				await beeper(1);
			} else {
				await beeper('*-*-*');
				logBestThetans([bestThetans[0]]);
				logger.info(`Bought thetan: ${result}`);
				await walletWatcher.update();
			}

			lastGoodThetansIds.push(...bestThetans.map((hero) => hero.id));
		}
	}
}

const logger = setupLogger();
main().catch((e: any) => {
	console.log(`Error: ${e}`);
	console.log('Restarting...');
	main();
});
