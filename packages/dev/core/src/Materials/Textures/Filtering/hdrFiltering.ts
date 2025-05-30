import { Vector3 } from "../../../Maths/math";
import { ILog2 } from "../../../Maths/math.scalar.functions";
import type { BaseTexture } from "../baseTexture";
import type { AbstractEngine } from "../../../Engines/abstractEngine";
import type { Effect } from "../../../Materials/effect";
import { Constants } from "../../../Engines/constants";
import { EffectWrapper, EffectRenderer } from "../../../Materials/effectRenderer";
import type { Nullable } from "../../../types";
import type { RenderTargetWrapper } from "../../../Engines/renderTargetWrapper";

import { ShaderLanguage } from "core/Materials/shaderLanguage";

/**
 * Options for texture filtering
 */
interface IHDRFilteringOptions {
    /**
     * Scales pixel intensity for the input HDR map.
     */
    hdrScale?: number;

    /**
     * Quality of the filter. Should be `Constants.TEXTURE_FILTERING_QUALITY_OFFLINE` for prefiltering
     */
    quality?: number;
}

/**
 * Filters HDR maps to get correct renderings of PBR reflections
 */
export class HDRFiltering {
    private _engine: AbstractEngine;
    private _effectRenderer: EffectRenderer;
    private _effectWrapper: EffectWrapper;

    private _lodGenerationOffset: number = 0;
    private _lodGenerationScale: number = 0.8;

    /**
     * Quality switch for prefiltering. Should be set to `Constants.TEXTURE_FILTERING_QUALITY_OFFLINE` unless
     * you care about baking speed.
     */
    public quality: number = Constants.TEXTURE_FILTERING_QUALITY_OFFLINE;

    /**
     * Scales pixel intensity for the input HDR map.
     */
    public hdrScale: number = 1;

    /**
     * Instantiates HDR filter for reflection maps
     *
     * @param engine Thin engine
     * @param options Options
     */
    constructor(engine: AbstractEngine, options: IHDRFilteringOptions = {}) {
        // pass
        this._engine = engine;
        this.hdrScale = options.hdrScale || this.hdrScale;
        this.quality = options.quality || this.quality;
    }

    private _createRenderTarget(size: number): RenderTargetWrapper {
        let textureType = Constants.TEXTURETYPE_UNSIGNED_BYTE;
        if (this._engine.getCaps().textureHalfFloatRender) {
            textureType = Constants.TEXTURETYPE_HALF_FLOAT;
        } else if (this._engine.getCaps().textureFloatRender) {
            textureType = Constants.TEXTURETYPE_FLOAT;
        }

        const rtWrapper = this._engine.createRenderTargetCubeTexture(size, {
            format: Constants.TEXTUREFORMAT_RGBA,
            type: textureType,
            createMipMaps: true,
            generateMipMaps: false,
            generateDepthBuffer: false,
            generateStencilBuffer: false,
            samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            label: "HDR_Radiance_Filtering_Target",
        });
        this._engine.updateTextureWrappingMode(rtWrapper.texture!, Constants.TEXTURE_CLAMP_ADDRESSMODE, Constants.TEXTURE_CLAMP_ADDRESSMODE, Constants.TEXTURE_CLAMP_ADDRESSMODE);

        this._engine.updateTextureSamplingMode(Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, rtWrapper.texture!, true);

        return rtWrapper;
    }

    private _prefilterInternal(texture: BaseTexture): BaseTexture {
        const width = texture.getSize().width;
        const mipmapsCount = ILog2(width) + 1;

        const effect = this._effectWrapper.effect;
        const outputTexture = this._createRenderTarget(width);
        this._effectRenderer.saveStates();
        this._effectRenderer.setViewport();

        const intTexture = texture.getInternalTexture();
        if (intTexture) {
            // Just in case generate fresh clean mips.
            this._engine.updateTextureSamplingMode(Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, intTexture, true);
        }

        this._effectRenderer.applyEffectWrapper(this._effectWrapper);

        const directions = [
            [new Vector3(0, 0, -1), new Vector3(0, -1, 0), new Vector3(1, 0, 0)], // PositiveX
            [new Vector3(0, 0, 1), new Vector3(0, -1, 0), new Vector3(-1, 0, 0)], // NegativeX
            [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 1, 0)], // PositiveY
            [new Vector3(1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, -1, 0)], // NegativeY
            [new Vector3(1, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1)], // PositiveZ
            [new Vector3(-1, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, -1)], // NegativeZ
        ];

        effect.setFloat("hdrScale", this.hdrScale);
        effect.setFloat2("vFilteringInfo", texture.getSize().width, mipmapsCount);
        effect.setTexture("inputTexture", texture);

        for (let face = 0; face < 6; face++) {
            effect.setVector3("up", directions[face][0]);
            effect.setVector3("right", directions[face][1]);
            effect.setVector3("front", directions[face][2]);

            for (let lod = 0; lod < mipmapsCount; lod++) {
                this._engine.bindFramebuffer(outputTexture, face, undefined, undefined, true, lod);
                this._effectRenderer.applyEffectWrapper(this._effectWrapper);

                let alpha = Math.pow(2, (lod - this._lodGenerationOffset) / this._lodGenerationScale) / width;
                if (lod === 0) {
                    alpha = 0;
                }

                effect.setFloat("alphaG", alpha);

                this._effectRenderer.draw();
            }
        }

        // Cleanup
        this._effectRenderer.restoreStates();
        this._engine.restoreDefaultFramebuffer();
        this._engine._releaseTexture(texture._texture!);

        // Internal Swap
        const type = outputTexture.texture!.type;
        const format = outputTexture.texture!.format;

        outputTexture._swapAndDie(texture._texture!);

        texture._texture!.type = type;
        texture._texture!.format = format;

        // New settings
        texture.gammaSpace = false;
        texture.lodGenerationOffset = this._lodGenerationOffset;
        texture.lodGenerationScale = this._lodGenerationScale;
        texture._prefiltered = true;

        return texture;
    }

    private _createEffect(texture: BaseTexture, onCompiled?: Nullable<(effect: Effect) => void>): EffectWrapper {
        const defines = [];
        if (texture.gammaSpace) {
            defines.push("#define GAMMA_INPUT");
        }

        defines.push("#define NUM_SAMPLES " + this.quality + "u"); // unsigned int

        const isWebGPU = this._engine.isWebGPU;

        const effectWrapper = new EffectWrapper({
            engine: this._engine,
            name: "hdrFiltering",
            vertexShader: "hdrFiltering",
            fragmentShader: "hdrFiltering",
            samplerNames: ["inputTexture"],
            uniformNames: ["vSampleDirections", "vWeights", "up", "right", "front", "vFilteringInfo", "hdrScale", "alphaG"],
            useShaderStore: true,
            defines,
            onCompiled: onCompiled,
            shaderLanguage: isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
            extraInitializationsAsync: async () => {
                if (isWebGPU) {
                    await Promise.all([import("../../../ShadersWGSL/hdrFiltering.vertex"), import("../../../ShadersWGSL/hdrFiltering.fragment")]);
                } else {
                    await Promise.all([import("../../../Shaders/hdrFiltering.vertex"), import("../../../Shaders/hdrFiltering.fragment")]);
                }
            },
        });

        return effectWrapper;
    }

    /**
     * Get a value indicating if the filter is ready to be used
     * @param texture Texture to filter
     * @returns true if the filter is ready
     */
    public isReady(texture: BaseTexture) {
        return texture.isReady() && this._effectWrapper.effect.isReady();
    }

    /**
     * Prefilters a cube texture to have mipmap levels representing roughness values.
     * Prefiltering will be invoked at the end of next rendering pass.
     * This has to be done once the map is loaded, and has not been prefiltered by a third party software.
     * See http://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_notes_v2.pdf for more information
     * @param texture Texture to filter
     * @returns Promise called when prefiltering is done
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public async prefilter(texture: BaseTexture): Promise<void> {
        if (!this._engine._features.allowTexturePrefiltering) {
            throw new Error("HDR prefiltering is not available in WebGL 1., you can use real time filtering instead.");
        }

        this._effectRenderer = new EffectRenderer(this._engine);
        this._effectWrapper = this._createEffect(texture);

        await this._effectWrapper.effect.whenCompiledAsync();

        this._prefilterInternal(texture);
        this._effectRenderer.dispose();
        this._effectWrapper.dispose();
    }
}
