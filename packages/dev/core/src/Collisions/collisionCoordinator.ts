import type { Nullable } from "../types";
import { Scene } from "../scene";
import { Vector3 } from "../Maths/math.vector";
import { Collider } from "./collider";
import type { AbstractMesh } from "../Meshes/abstractMesh";
import { AbstractEngine } from "core/Engines/abstractEngine";

/** @internal */
export interface ICollisionCoordinator {
    createCollider(): Collider;
    getNewPosition(
        position: Vector3,
        displacement: Vector3,
        collider: Collider,
        maximumRetry: number,
        excludedMesh: Nullable<AbstractMesh>,
        onNewPosition: (collisionIndex: number, newPosition: Vector3, collidedMesh: Nullable<AbstractMesh>) => void,
        collisionIndex: number,
        slideOnCollide?: boolean
    ): void;
    init(scene: Scene): void;
}

/** @internal */
export class DefaultCollisionCoordinator implements ICollisionCoordinator {
    private _scene: Scene;

    private _scaledPosition = Vector3.Zero();
    private _scaledVelocity = Vector3.Zero();

    private _finalPosition = Vector3.Zero();

    public getNewPosition(
        position: Vector3,
        displacement: Vector3,
        collider: Collider,
        maximumRetry: number,
        excludedMesh: AbstractMesh,
        onNewPosition: (collisionIndex: number, newPosition: Vector3, collidedMesh: Nullable<AbstractMesh>) => void,
        collisionIndex: number,
        slideOnCollide: boolean = true
    ): void {
        position.divideToRef(collider._radius, this._scaledPosition);
        displacement.divideToRef(collider._radius, this._scaledVelocity);
        collider.collidedMesh = null;
        collider._retry = 0;
        collider._initialVelocity = this._scaledVelocity;
        collider._initialPosition = this._scaledPosition;
        this._collideWithWorld(this._scaledPosition, this._scaledVelocity, collider, maximumRetry, this._finalPosition, slideOnCollide, excludedMesh);

        this._finalPosition.multiplyInPlace(collider._radius);
        //run the callback
        onNewPosition(collisionIndex, this._finalPosition, collider.collidedMesh);
    }

    public createCollider(): Collider {
        return new Collider();
    }

    public init(scene: Scene): void {
        this._scene = scene;
    }

    private _collideWithWorld(
        position: Vector3,
        velocity: Vector3,
        collider: Collider,
        maximumRetry: number,
        finalPosition: Vector3,
        slideOnCollide: boolean,
        excludedMesh: Nullable<AbstractMesh> = null
    ): void {
        const closeDistance = AbstractEngine.CollisionsEpsilon * 10.0;

        if (collider._retry >= maximumRetry) {
            finalPosition.copyFrom(position);
            return;
        }

        // Check if this is a mesh else camera or -1
        const collisionMask = excludedMesh ? excludedMesh.collisionMask : collider.collisionMask;

        collider._initialize(position, velocity, closeDistance);

        // Check if collision detection should happen against specified list of meshes or,
        // if not specified, against all meshes in the scene
        const meshes = (excludedMesh && excludedMesh.surroundingMeshes) || this._scene.meshes;

        for (let index = 0; index < meshes.length; index++) {
            const mesh = meshes[index];
            if (mesh.isEnabled() && mesh.checkCollisions && mesh.subMeshes && mesh !== excludedMesh && (collisionMask & mesh.collisionGroup) !== 0) {
                mesh._checkCollision(collider);
            }
        }

        if (!collider.collisionFound) {
            position.addToRef(velocity, finalPosition);
            return;
        }

        if (velocity.x !== 0 || velocity.y !== 0 || velocity.z !== 0) {
            collider._getResponse(position, velocity, slideOnCollide);
            // Halt all movement at the first collision, if not slideOnCollide
            if (!slideOnCollide) {
                velocity.setAll(0);
            }
        }

        if (velocity.length() <= closeDistance) {
            finalPosition.copyFrom(position);
            return;
        }

        collider._retry++;
        this._collideWithWorld(position, velocity, collider, maximumRetry, finalPosition, slideOnCollide, excludedMesh);
    }
}

Scene.CollisionCoordinatorFactory = () => {
    return new DefaultCollisionCoordinator();
};
