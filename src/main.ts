import beeper from 'beeper';
import log from 'simple-node-logger';
import { cts } from './utils/constants.js';
import { Marketplace } from './Marketplace.js';
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
	try {
		const earnExpectPercentage = parseFloat(process.argv[2]) || 0.5;
		const wbnbBalance = parseFloat(process.argv[3]) || 1;
		logger.info('Earn expect percentage: ' + earnExpectPercentage);
		logger.info('WBNB Balance: ' + wbnbBalance);
		console.log('Earn expect percentage: ' + earnExpectPercentage);
		console.log('WBNB Balance: ' + wbnbBalance);

		const coinWatcher = new CoinWatcher();
		await coinWatcher.start();

		const marketplace = new Marketplace();

		await findBestThetans(coinWatcher, marketplace, earnExpectPercentage, wbnbBalance);
	} catch (e: any) {
		logger.error(`App crashed:  ${e.message}`);
		console.error(`App crashed:  ${e.message}`);
		console.log('Restarting...');
		await main();
	}
}

async function findBestThetans(
	coinWatcher: CoinWatcher,
	marketplace: Marketplace,
	earnExpectPercentage: number,
	wbnbBalance: number
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
		bestThetans = bestThetans.filter((hero) => hero.price / 1e8 < wbnbBalance);
		//console.log(`Thetans number (less than ${wbnbBalance} WBNB): ${bestThetans.length}`);

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
				bestThetans[index].earnRate = earnRate;
				bestThetans[index].heroPriceDollar = ((hero.price * coinWatcher.coins.BNB) / 1e8).toFixed(2);
			}
			return earnRate >= earnExpectPercentage;
		});
		//console.log(`Thetans number (good earn potential): ${bestThetans.length}`);

		// *Remove unwanted thetans*
		bestThetans = bestThetans.filter((hero) => {
			// Increase difficulty of getting shitty Veinkas
			/*if (hero.name === 'Veinka' && hero.earnRate < earnExpectPercentage * 1.3) {
				return false;
			}*/
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
		return bestThetans.sort((a, b) => b.earnRate - a.earnRate);
	}

	async function logBestThetans(thetans: any[]) {
		await beeper('*-*-*');
		thetans.forEach((thetan: any) => {
			logger.info(`${thetan.name}(${thetan.id}):
	Current Time: ${new Date(Date.now()).toLocaleString()}
	Price: $${thetan.heroPriceDollar}; WBNB ${thetan.price / 1e8}
	Earn Potential: $${thetan.earnPotentialDollar}
	Earn Rate: ${(thetan.earnRate * 100).toFixed(2)}%
	Link: https://marketplace.thetanarena.com/item/${thetan.refId}`);
			console.log(`${thetan.name}(${thetan.id}):
	Current Time: ${new Date(Date.now()).toLocaleString()}
	Price: $${thetan.heroPriceDollar}; WBNB ${thetan.price / 1e8}
	Earn Potential: $${thetan.earnPotentialDollar}
	Earn Rate: ${(thetan.earnRate * 100).toFixed(2)}%
	Link: https://marketplace.thetanarena.com/item/${thetan.refId}`);
		});
	}

	let iterations = 0;
	while (true) {
		const thetans = await marketplace.getThetans();
		let bestThetans = await getBestThetans(thetans);
		bestThetans = filterAlreadyListedThetans(bestThetans);
		bestThetans = orderThetansByEarnRate(bestThetans);

		if (bestThetans && bestThetans.length > 0) {
			// Ignore the first thetans, they maybe are already bought
			if (iterations < 5) {
				lastGoodThetansIds.push(...bestThetans.map((hero) => hero.id));
				continue;
			}
			await logBestThetans(bestThetans);
			lastGoodThetansIds.push(...bestThetans.map((hero) => hero.id));
		}
		iterations++;
	}
}

const logger = setupLogger();

(async () => {
	await main();
})();
