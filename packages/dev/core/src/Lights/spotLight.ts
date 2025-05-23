import { serialize, serializeAsTexture } from "../Misc/decorators";
import type { Nullable } from "../types";
import type { Scene } from "../scene";
import { Matrix, Vector3 } from "../Maths/math.vector";
import { Node } from "../node";
import type { AbstractMesh } from "../Meshes/abstractMesh";
import type { Effect } from "../Materials/effect";
import type { BaseTexture } from "../Materials/Textures/baseTexture";
import { Light } from "./light";
import { ShadowLight } from "./shadowLight";
import { Texture } from "../Materials/Textures/texture";
import type { ProceduralTexture } from "../Materials/Textures/Procedurals/proceduralTexture";
import type { Camera } from "../Cameras/camera";
import { RegisterClass } from "../Misc/typeStore";
import { Constants } from "core/Engines/constants";

Node.AddNodeConstructor("Light_Type_2", (name, scene) => {
    return () => new SpotLight(name, Vector3.Zero(), Vector3.Zero(), 0, 0, scene);
});

/**
 * A spot light is defined by a position, a direction, an angle, and an exponent.
 * These values define a cone of light starting from the position, emitting toward the direction.
 * The angle, in radians, defines the size (field of illumination) of the spotlight's conical beam,
 * and the exponent defines the speed of the decay of the light with distance (reach).
 * Documentation: https://doc.babylonjs.com/features/featuresDeepDive/lights/lights_introduction
 */
export class SpotLight extends ShadowLight {
    /*
        upVector , rightVector and direction will form the coordinate system for this spot light.
        These three vectors will be used as projection matrix when doing texture projection.

        Also we have the following rules always holds:
        direction cross up   = right
        right cross direction = up
        up cross right       = forward

        light_near and light_far will control the range of the texture projection. If a plane is
        out of the range in spot light space, there is no texture projection.
    */

    private _angle: number;
    private _innerAngle: number = 0;
    private _cosHalfAngle: number;

    private _lightAngleScale: number;
    private _lightAngleOffset: number;

    private _iesProfileTexture: Nullable<BaseTexture> = null;

    /**
     * Gets or sets the IES profile texture used to create the spotlight
     * @see https://playground.babylonjs.com/#UIAXAU#1
     */
    public get iesProfileTexture(): Nullable<BaseTexture> {
        return this._iesProfileTexture;
    }

    public set iesProfileTexture(value: Nullable<BaseTexture>) {
        if (this._iesProfileTexture === value) {
            return;
        }

        this._iesProfileTexture = value;

        if (this._iesProfileTexture && SpotLight._IsTexture(this._iesProfileTexture)) {
            this._iesProfileTexture.onLoadObservable.addOnce(() => {
                this._markMeshesAsLightDirty();
            });
        }
    }

    /**
     * Gets the cone angle of the spot light in Radians.
     */
    @serialize()
    public get angle(): number {
        return this._angle;
    }
    /**
     * Sets the cone angle of the spot light in Radians.
     */
    public set angle(value: number) {
        this._angle = value;
        this._cosHalfAngle = Math.cos(value * 0.5);
        this._projectionTextureProjectionLightDirty = true;
        this.forceProjectionMatrixCompute();
        this._computeAngleValues();
    }

    /**
     * Only used in gltf falloff mode, this defines the angle where
     * the directional falloff will start before cutting at angle which could be seen
     * as outer angle.
     */
    @serialize()
    public get innerAngle(): number {
        return this._innerAngle;
    }
    /**
     * Only used in gltf falloff mode, this defines the angle where
     * the directional falloff will start before cutting at angle which could be seen
     * as outer angle.
     */
    public set innerAngle(value: number) {
        this._innerAngle = value;
        this._computeAngleValues();
    }

    private _shadowAngleScale: number;
    /**
     * Allows scaling the angle of the light for shadow generation only.
     */
    @serialize()
    public get shadowAngleScale(): number {
        return this._shadowAngleScale;
    }
    /**
     * Allows scaling the angle of the light for shadow generation only.
     */
    public set shadowAngleScale(value: number) {
        this._shadowAngleScale = value;
        this.forceProjectionMatrixCompute();
    }

    /**
     * The light decay speed with the distance from the emission spot.
     */
    @serialize()
    public exponent: number;

    private _projectionTextureMatrix = Matrix.Zero();
    /**
     * Allows reading the projection texture
     */
    public get projectionTextureMatrix(): Matrix {
        return this._projectionTextureMatrix;
    }

    protected _projectionTextureLightNear: number = 1e-6;
    /**
     * Gets the near clip of the Spotlight for texture projection.
     */
    @serialize()
    public get projectionTextureLightNear(): number {
        return this._projectionTextureLightNear;
    }
    /**
     * Sets the near clip of the Spotlight for texture projection.
     */
    public set projectionTextureLightNear(value: number) {
        this._projectionTextureLightNear = value;
        this._projectionTextureProjectionLightDirty = true;
    }

    protected _projectionTextureLightFar: number = 1000.0;
    /**
     * Gets the far clip of the Spotlight for texture projection.
     */
    @serialize()
    public get projectionTextureLightFar(): number {
        return this._projectionTextureLightFar;
    }
    /**
     * Sets the far clip of the Spotlight for texture projection.
     */
    public set projectionTextureLightFar(value: number) {
        this._projectionTextureLightFar = value;
        this._projectionTextureProjectionLightDirty = true;
    }

    protected _projectionTextureUpDirection: Vector3 = Vector3.Up();
    /**
     * Gets the Up vector of the Spotlight for texture projection.
     */
    @serialize()
    public get projectionTextureUpDirection(): Vector3 {
        return this._projectionTextureUpDirection;
    }
    /**
     * Sets the Up vector of the Spotlight for texture projection.
     */
    public set projectionTextureUpDirection(value: Vector3) {
        this._projectionTextureUpDirection = value;
        this._projectionTextureProjectionLightDirty = true;
    }

    @serializeAsTexture("projectedLightTexture")
    private _projectionTexture: Nullable<BaseTexture>;

    /**
     * Gets the projection texture of the light.
     */
    public get projectionTexture(): Nullable<BaseTexture> {
        return this._projectionTexture;
    }
    /**
     * Sets the projection texture of the light.
     */
    public set projectionTexture(value: Nullable<BaseTexture>) {
        if (this._projectionTexture === value) {
            return;
        }
        this._projectionTexture = value;
        this._projectionTextureDirty = true;
        if (this._projectionTexture && !this._projectionTexture.isReady()) {
            if (SpotLight._IsProceduralTexture(this._projectionTexture)) {
                this._projectionTexture.getEffect().executeWhenCompiled(() => {
                    this._markMeshesAsLightDirty();
                });
            } else if (SpotLight._IsTexture(this._projectionTexture)) {
                this._projectionTexture.onLoadObservable.addOnce(() => {
                    this._markMeshesAsLightDirty();
                });
            }
        }
    }

    private static _IsProceduralTexture(texture: BaseTexture): texture is ProceduralTexture {
        return (texture as ProceduralTexture).onGeneratedObservable !== undefined;
    }

    private static _IsTexture(texture: BaseTexture): texture is Texture {
        return (texture as Texture).onLoadObservable !== undefined;
    }

    private _projectionTextureViewLightDirty = true;
    private _projectionTextureProjectionLightDirty = true;
    private _projectionTextureDirty = true;
    private _projectionTextureViewTargetVector = Vector3.Zero();
    private _projectionTextureViewLightMatrix = Matrix.Zero();

    private _projectionTextureProjectionLightMatrix = Matrix.Zero();
    /**
     * Gets or sets the light projection matrix as used by the projection texture
     */
    public get projectionTextureProjectionLightMatrix(): Matrix {
        return this._projectionTextureProjectionLightMatrix;
    }

    public set projectionTextureProjectionLightMatrix(projection: Matrix) {
        this._projectionTextureProjectionLightMatrix = projection;
        this._projectionTextureProjectionLightDirty = false;
        this._projectionTextureDirty = true;
    }

    private _projectionTextureScalingMatrix = Matrix.FromValues(0.5, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.5, 0.5, 0.5, 1.0);

    /**
     * Creates a SpotLight object in the scene. A spot light is a simply light oriented cone.
     * It can cast shadows.
     * Documentation : https://doc.babylonjs.com/features/featuresDeepDive/lights/lights_introduction
     * @param name The light friendly name
     * @param position The position of the spot light in the scene
     * @param direction The direction of the light in the scene
     * @param angle The cone angle of the light in Radians
     * @param exponent The light decay speed with the distance from the emission spot
     * @param scene The scene the lights belongs to
     */
    constructor(name: string, position: Vector3, direction: Vector3, angle: number, exponent: number, scene?: Scene) {
        super(name, scene);

        this.position = position;
        this.direction = direction;
        this.angle = angle;
        this.exponent = exponent;
    }

    /**
     * Returns the string "SpotLight".
     * @returns the class name
     */
    public override getClassName(): string {
        return "SpotLight";
    }

    /**
     * Returns the integer 2.
     * @returns The light Type id as a constant defines in Light.LIGHTTYPEID_x
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    public override getTypeID(): number {
        return Light.LIGHTTYPEID_SPOTLIGHT;
    }

    /**
     * Overrides the direction setter to recompute the projection texture view light Matrix.
     * @param value
     */
    protected override _setDirection(value: Vector3) {
        super._setDirection(value);
        this._projectionTextureViewLightDirty = true;
    }

    /**
     * Overrides the position setter to recompute the projection texture view light Matrix.
     * @param value
     */
    protected override _setPosition(value: Vector3) {
        super._setPosition(value);
        this._projectionTextureViewLightDirty = true;
    }

    /**
     * Sets the passed matrix "matrix" as perspective projection matrix for the shadows and the passed view matrix with the fov equal to the SpotLight angle and and aspect ratio of 1.0.
     * Returns the SpotLight.
     * @param matrix
     * @param viewMatrix
     * @param renderList
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected _setDefaultShadowProjectionMatrix(matrix: Matrix, viewMatrix: Matrix, renderList: Array<AbstractMesh>): void {
        const activeCamera = this.getScene().activeCamera;

        if (!activeCamera) {
            return;
        }

        this._shadowAngleScale = this._shadowAngleScale || 1;
        const angle = this._shadowAngleScale * this._angle;

        const minZ = this.shadowMinZ !== undefined ? this.shadowMinZ : activeCamera.minZ;
        const maxZ = this.shadowMaxZ !== undefined ? this.shadowMaxZ : activeCamera.maxZ;

        const useReverseDepthBuffer = this.getScene().getEngine().useReverseDepthBuffer;

        Matrix.PerspectiveFovLHToRef(
            angle,
            1.0,
            useReverseDepthBuffer ? maxZ : minZ,
            useReverseDepthBuffer ? minZ : maxZ,
            matrix,
            true,
            this._scene.getEngine().isNDCHalfZRange,
            undefined,
            useReverseDepthBuffer
        );
    }

    protected _computeProjectionTextureViewLightMatrix(): void {
        this._projectionTextureViewLightDirty = false;
        this._projectionTextureDirty = true;

        this.getAbsolutePosition().addToRef(this.getShadowDirection(), this._projectionTextureViewTargetVector);
        Matrix.LookAtLHToRef(this.getAbsolutePosition(), this._projectionTextureViewTargetVector, this._projectionTextureUpDirection, this._projectionTextureViewLightMatrix);
    }

    protected _computeProjectionTextureProjectionLightMatrix(): void {
        this._projectionTextureProjectionLightDirty = false;
        this._projectionTextureDirty = true;

        const lightFar = this.projectionTextureLightFar;
        const lightNear = this.projectionTextureLightNear;

        const p = lightFar / (lightFar - lightNear);
        const q = -p * lightNear;
        const s = 1.0 / Math.tan(this._angle / 2.0);
        const a = 1.0;

        Matrix.FromValuesToRef(s / a, 0.0, 0.0, 0.0, 0.0, s, 0.0, 0.0, 0.0, 0.0, p, 1.0, 0.0, 0.0, q, 0.0, this._projectionTextureProjectionLightMatrix);
    }

    /**
     * Main function for light texture projection matrix computing.
     */
    protected _computeProjectionTextureMatrix(): void {
        this._projectionTextureDirty = false;

        this._projectionTextureViewLightMatrix.multiplyToRef(this._projectionTextureProjectionLightMatrix, this._projectionTextureMatrix);
        if (this._projectionTexture instanceof Texture) {
            const u = this._projectionTexture.uScale / 2.0;
            const v = this._projectionTexture.vScale / 2.0;
            Matrix.FromValuesToRef(u, 0.0, 0.0, 0.0, 0.0, v, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.5, 0.5, 0.5, 1.0, this._projectionTextureScalingMatrix);
        }
        this._projectionTextureMatrix.multiplyToRef(this._projectionTextureScalingMatrix, this._projectionTextureMatrix);
    }

    protected _buildUniformLayout(): void {
        this._uniformBuffer.addUniform("vLightData", 4);
        this._uniformBuffer.addUniform("vLightDiffuse", 4);
        this._uniformBuffer.addUniform("vLightSpecular", 4);
        this._uniformBuffer.addUniform("vLightDirection", 3);
        this._uniformBuffer.addUniform("vLightFalloff", 4);
        this._uniformBuffer.addUniform("shadowsInfo", 3);
        this._uniformBuffer.addUniform("depthValues", 2);
        this._uniformBuffer.create();
    }

    private _computeAngleValues(): void {
        this._lightAngleScale = 1.0 / Math.max(0.001, Math.cos(this._innerAngle * 0.5) - this._cosHalfAngle);
        this._lightAngleOffset = -this._cosHalfAngle * this._lightAngleScale;
    }

    /**
     * Sets the passed Effect "effect" with the Light textures.
     * @param effect The effect to update
     * @param lightIndex The index of the light in the effect to update
     * @returns The light
     */
    public override transferTexturesToEffect(effect: Effect, lightIndex: string): Light {
        if (this.projectionTexture && this.projectionTexture.isReady()) {
            if (this._projectionTextureViewLightDirty) {
                this._computeProjectionTextureViewLightMatrix();
            }
            if (this._projectionTextureProjectionLightDirty) {
                this._computeProjectionTextureProjectionLightMatrix();
            }
            if (this._projectionTextureDirty) {
                this._computeProjectionTextureMatrix();
            }
            effect.setMatrix("textureProjectionMatrix" + lightIndex, this._projectionTextureMatrix);
            effect.setTexture("projectionLightTexture" + lightIndex, this.projectionTexture);
        }

        if (this._iesProfileTexture && this._iesProfileTexture.isReady()) {
            effect.setTexture("iesLightTexture" + lightIndex, this._iesProfileTexture);
        }
        return this;
    }

    /**
     * Sets the passed Effect object with the SpotLight transformed position (or position if not parented) and normalized direction.
     * @param effect The effect to update
     * @param lightIndex The index of the light in the effect to update
     * @returns The spot light
     */
    public transferToEffect(effect: Effect, lightIndex: string): SpotLight {
        let normalizeDirection;

        if (this.computeTransformedInformation()) {
            this._uniformBuffer.updateFloat4("vLightData", this.transformedPosition.x, this.transformedPosition.y, this.transformedPosition.z, this.exponent, lightIndex);

            normalizeDirection = Vector3.Normalize(this.transformedDirection);
        } else {
            this._uniformBuffer.updateFloat4("vLightData", this.position.x, this.position.y, this.position.z, this.exponent, lightIndex);

            normalizeDirection = Vector3.Normalize(this.direction);
        }

        this._uniformBuffer.updateFloat4("vLightDirection", normalizeDirection.x, normalizeDirection.y, normalizeDirection.z, this._cosHalfAngle, lightIndex);

        this._uniformBuffer.updateFloat4("vLightFalloff", this.range, this._inverseSquaredRange, this._lightAngleScale, this._lightAngleOffset, lightIndex);
        return this;
    }

    public transferToNodeMaterialEffect(effect: Effect, lightDataUniformName: string) {
        let normalizeDirection;

        if (this.computeTransformedInformation()) {
            normalizeDirection = Vector3.Normalize(this.transformedDirection);
        } else {
            normalizeDirection = Vector3.Normalize(this.direction);
        }

        if (this.getScene().useRightHandedSystem) {
            effect.setFloat3(lightDataUniformName, -normalizeDirection.x, -normalizeDirection.y, -normalizeDirection.z);
        } else {
            effect.setFloat3(lightDataUniformName, normalizeDirection.x, normalizeDirection.y, normalizeDirection.z);
        }

        return this;
    }

    /**
     * Disposes the light and the associated resources.
     */
    public override dispose(): void {
        super.dispose();
        if (this._projectionTexture) {
            this._projectionTexture.dispose();
        }
        if (this._iesProfileTexture) {
            this._iesProfileTexture.dispose();
            this._iesProfileTexture = null;
        }
    }

    /**
     * Gets the minZ used for shadow according to both the scene and the light.
     * @param activeCamera The camera we are returning the min for
     * @returns the depth min z
     */
    public override getDepthMinZ(activeCamera: Nullable<Camera>): number {
        const engine = this._scene.getEngine();
        const minZ = this.shadowMinZ !== undefined ? this.shadowMinZ : (activeCamera?.minZ ?? Constants.ShadowMinZ);

        return engine.useReverseDepthBuffer && engine.isNDCHalfZRange ? minZ : this._scene.getEngine().isNDCHalfZRange ? 0 : minZ;
    }

    /**
     * Gets the maxZ used for shadow according to both the scene and the light.
     * @param activeCamera The camera we are returning the max for
     * @returns the depth max z
     */
    public override getDepthMaxZ(activeCamera: Nullable<Camera>): number {
        const engine = this._scene.getEngine();
        const maxZ = this.shadowMaxZ !== undefined ? this.shadowMaxZ : (activeCamera?.maxZ ?? Constants.ShadowMaxZ);

        return engine.useReverseDepthBuffer && engine.isNDCHalfZRange ? 0 : maxZ;
    }

    /**
     * Prepares the list of defines specific to the light type.
     * @param defines the list of defines
     * @param lightIndex defines the index of the light for the effect
     */
    public prepareLightSpecificDefines(defines: any, lightIndex: number): void {
        defines["SPOTLIGHT" + lightIndex] = true;
        defines["PROJECTEDLIGHTTEXTURE" + lightIndex] = this.projectionTexture && this.projectionTexture.isReady() ? true : false;
        defines["IESLIGHTTEXTURE" + lightIndex] = this._iesProfileTexture && this._iesProfileTexture.isReady() ? true : false;
    }
}

// Register Class Name
RegisterClass("BABYLON.SpotLight", SpotLight);
