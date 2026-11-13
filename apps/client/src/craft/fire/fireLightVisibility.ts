import type {FireSchool} from "@robo/shared";
type Point=readonly[number,number,number];
/** Direct orange glow reaches the hall through the open door, never through a partition. */
export function fireLightVisible(school:FireSchool,from:Point,to:Point):boolean{
 const r=school.heat;
 if(to[1]<r[1]||to[1]>r[4])return false;
 if(to[0]>r[0]&&to[0]<r[3]&&to[2]>r[2]&&to[2]<r[5])return true;
 const c=school.corridor;if(to[0]<c[0]||to[0]>c[3]||to[2]<c[2]||to[2]>c[5])return false;
 const door=school.fireDoor,dz=to[2]-from[2];if(dz<=0)return false;
 const t=(door[2]-from[2])/dz;if(t<=0||t>=1)return false;
 const x=from[0]+(to[0]-from[0])*t,y=from[1]+(to[1]-from[1])*t;
 return x>=door[0]&&x<=door[3]&&y>=door[1]&&y<=door[4];
}
export const FIRE_LIGHT_VISIBILITY_GLSL=/* glsl */`
  uniform vec3 uFireDoorMin, uFireDoorMax;
  uniform vec4 uFireHall;
  float fireLightVisible(vec3 p) {
    if(p.y<uGridMin.y||p.y>uFireTop)return 0.0;
    if(inRoom(p))return 1.0;
    if(p.x<uFireHall.x||p.x>uFireHall.z||p.z<uFireHall.y||p.z>uFireHall.w)return 0.0;
    vec3 ray=p-uFire;
    if(ray.z<=0.0)return 0.0;
    float t=(uFireDoorMin.z-uFire.z)/ray.z;
    if(t<=0.0||t>=1.0)return 0.0;
    vec3 q=uFire+ray*t;
    return step(uFireDoorMin.x,q.x)*step(q.x,uFireDoorMax.x)*step(uFireDoorMin.y,q.y)*step(q.y,uFireDoorMax.y);
  }
`;
