import { Plugin } from 'rollup'
import makeHandler from './make-handler'

export default function vite(...args: Parameters<typeof makeHandler>) {
	const handler = makeHandler(...args)

	const plugin: Plugin = {
		name: 'tailwindcss-spritesmith',
		watchChange: {
			sequential: true,
			handler,
		},
		buildStart: {
			sequential: true,
			handler,
		},
	}
	return plugin
}
