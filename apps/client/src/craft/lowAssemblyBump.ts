import {kitConnectorGeometry,KIT_CONNECTOR_HEIGHT} from "./kitShell.js";
export const LOW_ASSEMBLY_BUMP_HEIGHT=KIT_CONNECTOR_HEIGHT;
/** Natural terrain and construction pieces share the same restrained closed stud cluster. */
export function lowAssemblyBumpGeometry():ReturnType<typeof kitConnectorGeometry> {
 const geometry=kitConnectorGeometry(),count=geometry.getAttribute("position").count;geometry.setIndex(Array.from({length:count},(_,i)=>i));geometry.addGroup(0,count,0);return geometry;
}
