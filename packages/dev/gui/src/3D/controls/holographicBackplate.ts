import type { TransformNode } from "core/Meshes/transformNode";
import type { Mesh } from "core/Meshes/mesh";
import { CreateBox } from "core/Meshes/Builders/boxBuilder";
import type { Scene } from "core/scene";
import { FluentBackplateMaterial } from "../materials/fluentBackplate/fluentBackplateMaterial";
import { Control3D } from "./control3D";
import { SceneLoader } from "core/Loading/sceneLoader";
import type { AbstractMesh } from "core/Meshes/abstractMesh";
import { Tools } from "core/Misc/tools";

/**
 * Class used to create a holographic backplate in 3D
 * @since 5.0.0
 */
export class HolographicBackplate extends Control3D {
    /**
     * Base Url for the button model.
     */
    public static MODEL_BASE_URL: string = "https://assets.babylonjs.com/core/MRTK/";
    /**
     * File name for the button model.
     */
    public static MODEL_FILENAME: string = "mrtk-fluent-backplate.glb";

    private _model: AbstractMesh;
    private _material: FluentBackplateMaterial;

    /**
     * Rendering ground id of the backplate mesh.
     */
    public set renderingGroupId(id: number) {
        this._model.renderingGroupId = id;
    }
    public get renderingGroupId(): number {
        return this._model.renderingGroupId;
    }

    /**
     * Gets the material used by the backplate
     */
    public get material(): FluentBackplateMaterial {
        return this._material;
    }

    /**
     * Gets a boolean indicating if this backplate shares its material with other HolographicBackplates
     */
    public get shareMaterials(): boolean {
        return this._shareMaterials;
    }

    /**
     * Creates a new holographic backplate
     * @param name defines the control name
     * @param _shareMaterials
     */
    constructor(
        name?: string,
        private _shareMaterials = true
    ) {
        super(name);
    }

    protected override _getTypeName(): string {
        return "HolographicBackplate";
    }

    // Mesh association
    protected override _createNode(scene: Scene): TransformNode {
        const collisionMesh = CreateBox(
            (this.name ?? "HolographicBackplate") + "_CollisionMesh",
            {
                width: 1.0,
                height: 1.0,
                depth: 1.0,
            },
            scene
        );
        collisionMesh.isPickable = true;
        collisionMesh.visibility = 0;
        const baseUrl = Tools.GetAssetUrl(HolographicBackplate.MODEL_BASE_URL);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises, github/no-then
        SceneLoader.ImportMeshAsync(undefined, baseUrl, HolographicBackplate.MODEL_FILENAME, scene).then((result) => {
            const importedModel = result.meshes[1];
            importedModel.name = `${this.name}_frontPlate`;
            importedModel.isPickable = false;
            importedModel.parent = collisionMesh;
            if (this._material) {
                importedModel.material = this._material;
            }
            this._model = importedModel;
        });

        return collisionMesh;
    }

    private _createMaterial(mesh: Mesh) {
        this._material = new FluentBackplateMaterial(this.name + " Material", mesh.getScene());
    }

    protected override _affectMaterial(mesh: Mesh) {
        // Back
        if (this._shareMaterials) {
            if (!this._host._touchSharedMaterials["fluentBackplateMaterial"]) {
                this._createMaterial(mesh);
                this._host._touchSharedMaterials["fluentBackplateMaterial"] = this._material;
            } else {
                this._material = this._host._touchSharedMaterials["fluentBackplateMaterial"] as FluentBackplateMaterial;
            }
        } else {
            this._createMaterial(mesh);
        }
    }

    /**
     * Releases all associated resources
     */
    public override dispose() {
        super.dispose(); // will dispose main mesh ie. back plate

        if (!this.shareMaterials) {
            this._material.dispose();
        }

        this._model.dispose();
    }
}
