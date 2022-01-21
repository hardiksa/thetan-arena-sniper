import { request } from 'undici';
import { urls } from './utils/urls.js';

class Marketplace {
	constructor() {}

	public async getThetans(): Promise<any[]> {
		try {
			const startTime = process.hrtime();
			const { statusCode, body } = await request(urls.GET_THETANS);
			const endTime = process.hrtime(startTime);
			console.log(`listThetans took ${endTime[0] * 1000 + endTime[1] / 1000000}ms`);

			if (statusCode !== 200) {
				throw new Error(`Network error: ${statusCode}`);
			}
			const json = await body.json();
			if (!json.success) {
				throw new Error(`API error: ${json?.data} - ${json?.errors}`);
			}
			if (!json?.data) {
				throw new Error(`API error: no thetans returned`);
			}
			return json.data;
		} catch (error) {
			console.log(`Error getting thetans: ${error}`);
			return [];
		}
	}
}

export { Marketplace };
