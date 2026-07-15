# Third-party notices

The native Node KPF writer in `src/kindle-kpf.ts` is based on format research and the MIT-licensed implementation published in [HankunYu/kindle-comic-workaround-5.19.x](https://github.com/HankunYu/kindle-comic-workaround-5.19.x). It has been independently adapted to TypeScript and extended for explicit source-spread pairing, Scribe Colorsoft artwork bounds, black fixed-layout backgrounds, and Kindle Virtual Panel metadata.

Optional JPEGli encoding invokes a separately installed [`cjpegli`](https://github.com/google/jpegli) executable. JPEGli is distributed by Google under the BSD 3-Clause License and is not bundled with CBZ2ScribeColor.

The generated KPF/KFX structures use reverse-engineered, undocumented Amazon Kindle formats. Amazon, Kindle, Kindle Create, Kindle Previewer, and KFX are trademarks of Amazon.com, Inc. or its affiliates. This project is independent and is not affiliated with or endorsed by Amazon.
