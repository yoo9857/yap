/**
 * Power-plant construction rules: they live in @robo/shared (packages/shared/src/plants.ts), so a
 * classroom's server judges every plant change by the same code. Re-exported here under the names
 * science mode has always used.
 */
export {
  BLUEPRINTS, MAX_PLANTS, PLANT_KINDS, fitItem, isFilled, loadPlants, missingParts, plantProgress, plantSaveSchema,
  plantStatus, plantTurn as turn, savePlants, siteAt, siteProblem, siteSockets, socketMask, socketOpen, takeOut,
} from "@robo/shared";
export type {
  Blueprint, BlueprintSocket, BuildState, FitResult, PlantKind, PlantSite, PlantStatus, PlantTuple, Progress,
  SiteProblem, SiteSocket, SocketItem, SocketKind, TakeOutResult,
} from "@robo/shared";
