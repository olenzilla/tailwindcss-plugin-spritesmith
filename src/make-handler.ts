import { existsSync, writeFile, rm, readFile } from 'fs-extra'
import { join, basename, dirname } from 'path'
import { memoize } from 'lodash'
import { glob } from 'glob'
import { Path } from 'path-scurry'
import { CSSRuleObject, ThemeConfig } from 'tailwindcss/types/config'
import Spritesmith from 'spritesmith'
import { mkdirp } from 'mkdirp'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'

declare module 'tailwindcss/types/config' {
	interface ThemeConfig {
		spriteWidth: Record<string, string>
		spriteHeight: Record<string, string>
	}
}

type Config = {
	spritesheets?:
		| SpritesheetConfig[]
		| ({
				spritesDirGlob: string
				outputBackgroundImage?(outputImage: string): string
				/**
				 * @default ```
				 * ['png', 'jpg']
				 * ```
				 */
				extensions?: string[]
		  } & (
				| {
						outputDir: string
						outputImage?(spritesDir: Path, extension: string): string
				  }
				| { outputImage(spritesDir: Path, extension: string): string }
		  ))
	emitUtilitiesWithExtension?: boolean
	errorOnNameConflict?: boolean
	/** If specified, the spritesheet image and JSON file output to `tailwindcssOutputUtilitiesJson` will be cached if the set of sprite images is unchanged. */
	cacheDir?: string
	/** Default: 1; use 2 for retina. */
	pixelDensity?: number
	spritesmithOptions?: SpritesmithOptions
}
type SpritesheetConfig = {
	spriteImageGlob: string
	outputImage: string
	outputBackgroundImage?(outputImage: string): string
	/** Defaults to the root config's pixelDensity, which is 1; use 2 for retina. */
	pixelDensity?: number
}
type SpritesmithOptions = {
	[P in Exclude<
		keyof Parameters<(typeof Spritesmith)['run']>[0],
		'src' | 'callback'
	>]?: Parameters<(typeof Spritesmith)['run']>[0][P]
}

export default function makeHandler(
	config?: Config,
	tailwindcssOutputUtilitiesJson = 'tailwindcss-spritesmith-utilities.json',
) {
	const {
		spritesheets = [],
		emitUtilitiesWithExtension,
		errorOnNameConflict,
		cacheDir = '.cache/tailwind-plugin-spritesmith',
		pixelDensity: defaultPixelDensity = 1,
		spritesmithOptions = { padding: 2 },
	} = config ?? {}

	async function getSpritesheetConfigs() {
		return filterBoolean(
			Array.isArray(spritesheets)
				? spritesheets
				: await (async function () {
						const { spritesDirGlob, extensions, outputBackgroundImage } =
							spritesheets
						const outputImage =
							'outputDir' in spritesheets
								? spritesheets.outputImage ??
								  function (spritesDir, ext) {
										return join(
											spritesheets.outputDir,
											`${spritesDir.name}.${ext}`,
										)
								  }
								: spritesheets.outputImage
						return (
							await glob(spritesDirGlob, { withFileTypes: true })
						).flatMap((spritesDir) => {
							if (spritesDir.isDirectory()) {
								return (extensions ?? ['png', 'jpg']).map(
									function (ext): SpritesheetConfig {
										return {
											spriteImageGlob: join(
												spritesDir.path,
												spritesDir.name,
												`./*.${ext}`,
											),
											outputImage: outputImage(spritesDir, ext),
											outputBackgroundImage,
										}
									},
								)
							}
						})
				  })(),
		)
	}

	async function getSpritesInfo() {
		const allUtilities: string[] = []
		return (await getSpritesheetConfigs()).reduce(
			async (
				lastResult,
				{
					spriteImageGlob,
					outputImage,
					outputBackgroundImage = function (outputImage) {
						return `url(${outputImage})`
					},
					pixelDensity = defaultPixelDensity,
				},
			) => {
				const result = await lastResult
				const backgroundImage = outputBackgroundImage(outputImage)
				const spriteImages = (await glob(spriteImageGlob)).sort()
				const hash = createHash('sha1')
				hash.update(JSON.stringify(spritesmithOptions))
				const spritesheetImageHash = spriteImages
					.reduce(
						(hash, image) => {
							hash.update(image)
							return hash
						},
						await hashFileContents(hash, ...spriteImages),
					)
					.digest('hex')
				result[outputImage] = {
					backgroundImage,
					spriteImages,
					pixelDensity,
					spritesheetImageHash,
				}
				return result
			},
			Promise.resolve<
				Record<
					string,
					{
						backgroundImage: string
						spriteImages: string[]
						pixelDensity: number
						spritesheetImageHash: string
					}
				>
			>({}),
		)
	}

	const createUtilities = memoize(async function (spritesInfoString: string) {
		const spritesInfo: PromiseType<ReturnType<typeof getSpritesInfo>> =
			JSON.parse(spritesInfoString)
		const utilities = await Object.entries(spritesInfo).reduce(
			async (
				lastResult,
				[
					outputImage,
					{ backgroundImage, spriteImages, pixelDensity, spritesheetImageHash },
				],
			) => {
				if (!spriteImages.length) {
					return lastResult
				}
				const { utilities, theme } = await lastResult

				const spritesheetCacheDir = join(cacheDir, spritesheetImageHash)
				const spritesheetResult: Spritesmith.SpritesmithResult =
					cacheDir && existsSync(spritesheetCacheDir)
						? {
								coordinates: JSON.parse(
									await readFile(
										join(spritesheetCacheDir, 'coordinates'),
										'utf8',
									),
								),
								image: await readFile(join(spritesheetCacheDir, 'image')),
								properties: JSON.parse(
									await readFile(
										join(spritesheetCacheDir, 'properties'),
										'utf8',
									),
								),
						  }
						: await new Promise(async (resolve, reject) =>
								Spritesmith.run(
									{
										...spritesmithOptions,
										src: spriteImages,
									},
									async function (err, result) {
										if (err) {
											reject(err)
										} else {
											if (cacheDir) {
												if (!existsSync(spritesheetCacheDir)) {
													await mkdirp(spritesheetCacheDir)
												}
												await Promise.all([
													writeFile(
														join(spritesheetCacheDir, 'coordinates'),
														JSON.stringify(result.coordinates),
														'utf8',
													),
													writeFile(
														join(spritesheetCacheDir, 'image'),
														result.image,
													),
													writeFile(
														join(spritesheetCacheDir, 'properties'),
														JSON.stringify(result.properties),
														'utf8',
													),
												])
											}
											resolve(result)
										}
									},
								),
						  )

				Object.entries(spritesheetResult.coordinates).forEach(
					([spriteImage, { x, y, width, height }]) => {
						const utility = {
							'&': {
								backgroundImage,
								backgroundPosition: `${
									(x / (spritesheetResult.properties.width - width)) * 100
								}% ${
									(y / (spritesheetResult.properties.height - height)) * 100
								}%`,
								backgroundSize: `${
									(spritesheetResult.properties.width / width) * 100
								}% ${(spritesheetResult.properties.height / height) * 100}%`,
								width: `${width / pixelDensity}px`,
								overflow: 'hidden',
							},
							'&:before': {
								content: "''",
								display: 'block',
								paddingTop: `${(height / width) * 100}%`,
								width: `${width / pixelDensity}px`,
								maxWidth: '100%',
							},
						}
						const withExtension = basename(spriteImage)
						const withoutExtension = withExtension.replace(/\.\w+$/, '')
						if (emitUtilitiesWithExtension) {
							const nameWithExtension = `sprite-${withExtension}`
							if (errorOnNameConflict) {
								if (nameWithExtension in utilities) {
									throw new Error(
										`Sprite utility name conflict! ${nameWithExtension}`,
									)
								}
							}
							utilities[nameWithExtension] = utility
						}
						const nameWithoutExtension = `sprite-${withoutExtension}`
						if (errorOnNameConflict) {
							if (nameWithoutExtension in utilities) {
								throw new Error(
									`Sprite utility name conflict! ${nameWithoutExtension}`,
								)
							}
						}
						utilities[nameWithoutExtension] = utility

						theme.spriteWidth[nameWithoutExtension] = `${
							width / pixelDensity
						}px`
						theme.spriteHeight[nameWithoutExtension] = `${
							height / pixelDensity
						}px`
					},
				)

				if (existsSync(outputImage)) {
					if (
						!cacheDir &&
						(await hashFileContents(undefined, outputImage)) !=
							(await hashFileContents(
								undefined,
								join(spritesheetCacheDir, 'image'),
							))
					) {
						await new Promise((resolve) => rm(outputImage, resolve))
					}
				} else {
					await mkdirp(dirname(outputImage))
				}
				if (!existsSync(outputImage)) {
					await writeFile(
						outputImage,
						spritesheetResult.image as unknown as Buffer,
					)
				}

				return { utilities, theme }
			},
			Promise.resolve({
				utilities: <CSSRuleObject>{},
				theme: <ThemeConfig>{ spriteWidth: {}, spriteHeight: {} },
			}),
		)

		const tailwindcssUtilitiesJson = JSON.stringify(utilities, undefined, '\t')

		if (
			!existsSync(tailwindcssOutputUtilitiesJson) ||
			tailwindcssUtilitiesJson !=
				(await readFile(tailwindcssOutputUtilitiesJson, 'utf8'))
		) {
			await writeFile(
				tailwindcssOutputUtilitiesJson,
				tailwindcssUtilitiesJson,
				'utf8',
			)
		}
	})

	return async function handler() {
		await createUtilities(JSON.stringify(await getSpritesInfo()))
	}
}

function filterBoolean<T>(array: T[]) {
	return array.filter(Boolean) as Exclude<
		T,
		void | undefined | null | false | 0 | ''
	>[]
}

function logAndReturn<T>(val: T, ...logArgs: any[]) {
	console.log(...logArgs, val)
	return val
}

type PromiseType<T> = T extends Promise<infer U> ? U : T

async function hashFileContents(hash = createHash('sha1'), ...files: string[]) {
	await files.reduce(async (lastResult, file) => {
		await lastResult
		return new Promise<void>(function (resolve, reject) {
			try {
				hash.update(file)
				const input = createReadStream(file)
				input.on('readable', function () {
					try {
						const data = input.read()
						if (data) {
							hash.update(data)
						} else {
							resolve()
						}
					} catch (e) {
						reject(e)
					}
				})
			} catch (e) {
				reject(e)
			}
		})
	}, Promise.resolve())
	return hash
}
