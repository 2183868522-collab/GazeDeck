# Third-party components and reuse status

## GazeDeck code and research features

Code and data licenses are separately pending author specification. No repository-wide permissive license is added. The project owner's authorization to make this release public is not represented as an unrestricted downstream reuse license.

## MediaPipe

Local `vendor/` files package `@mediapipe/tasks-vision` 0.10.35. Its upstream license is Apache-2.0. Original vendor notices are retained and the full text is included in `third-party-licenses/Apache-2.0.txt`.

`models/face_landmarker.task` is Google's Face Landmarker float16/1 bundle. The included file SHA-256 is `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.

Official sources checked for the bundle and component license declarations:

- [Face Landmarker overview](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [Model bundle](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task)
- [Face Mesh V2 model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf)
- [Blendshape V2 model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf)
- [BlazeFace short-range model card](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf)

The component model cards declare Apache-2.0. MediaPipe is a third-party feature extractor, distinct from the GazeDeck research templates and their pending data reuse terms.

## SoundCraft integration source

The optional source ZIP is based on [SoundCraft](https://github.com/storytold/soundcraft), copyright ArtCraft Team and SoundCraft contributors, with upstream MIT OR Apache-2.0 terms. Both full license texts, NOTICE and ATTRIBUTION.md are retained alongside and inside the archive. Dependency fonts and other assets retain the terms documented there. Native dependencies are fetched by Cargo rather than bundled as an installed environment.

Eight restricted ArtCraft logo/mark assets are excluded from this modified distribution; the brand-terms document remains as a record. The archive does not imply upstream endorsement or official product status. Local GazeDeck integration changes are identified as such; no new license for those additions is asserted.
