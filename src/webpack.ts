import makeHandler from './make-handler'
import { Compiler } from 'webpack'

export default function webpack(...args: Parameters<typeof makeHandler>) {
	const handler = makeHandler(...args)

	return class {
		apply(compiler: Compiler) {
			compiler.hooks.run.tapAsync(
				'tailwindcss-plugin-spritesmith',
				(compiler, done) => {
					handler().then(
						() => done(),
						(err) => done(err),
					)
				},
			)
			compiler.hooks.watchRun.tapAsync(
				'tailwindcss-plugin-spritesmith',
				(compiler, done) => {
					handler().then(
						() => done(),
						(err) => done(err),
					)
				},
			)
		}
	}
}
