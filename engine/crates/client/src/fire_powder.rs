//! Dry powder particles retain their release direction when the nozzle swings.
use glam::DVec3;

struct Puff {
    position: DVec3,
    velocity: DVec3,
    direction: DVec3,
    travel: f64,
    range: f64,
    age: f64,
    life: f64,
    size: f64,
    settled: bool,
}

#[derive(Default)]
pub(crate) struct Powder {
    puffs: Vec<Puff>,
    previous: Option<(DVec3, DVec3)>,
    budget: f64,
    sequence: u32,
}

impl Powder {
    pub fn step(&mut self, dt: f64, spray: Option<(DVec3, DVec3, f64)>) {
        let dt = dt.clamp(0., 0.08);
        self.puffs.retain_mut(|p| {
            p.advance(dt);
            p.age < p.life
        });
        let Some((from, direction, range)) = spray else {
            self.previous = None;
            return;
        };
        if self.previous.is_none() {
            self.budget = 3.;
        }
        let (last_from, last_dir) = self
            .previous
            .replace((from, direction))
            .unwrap_or((from, direction));
        self.budget += dt * 250.;
        let count = self.budget.floor() as u32;
        self.budget -= f64::from(count);
        for i in 0..count {
            let t = (f64::from(i) + 0.5) / f64::from(count);
            self.sequence = self.sequence.wrapping_add(1);
            let n = f64::from(self.sequence);
            let dir = last_dir.lerp(direction, t).normalize_or(direction);
            let right = dir
                .cross(if dir.y.abs() > 0.95 {
                    DVec3::Z
                } else {
                    DVec3::Y
                })
                .normalize_or_zero();
            let up = right.cross(dir);
            let angle = n * 2.39996323;
            let spread = (n * 0.754877666).fract().sqrt();
            let radial = right * angle.cos() + up * angle.sin();
            let speed = range * (3.4 + (n * 0.56984029).fract() * 2.2);
            let scale = (range * 0.58).clamp(0.35, 1.);
            let mut puff = Puff {
                position: last_from.lerp(from, t) + radial * (0.006 * scale * spread),
                velocity: (dir + radial * (0.042 + spread * 0.133)) * speed,
                direction: dir,
                travel: 0.,
                range: range * (0.88 + (n * std::f64::consts::FRAC_1_PI).fract() * 0.12),
                age: 0.,
                life: 0.64 + (n * 0.618033989).fract() * 0.56,
                size: scale * (0.018 + spread * 0.015),
                settled: false,
            };
            puff.advance(dt * (1. - t));
            self.puffs.push(puff);
        }
    }

    pub fn visible(&self) -> impl Iterator<Item = (DVec3, f64, [u8; 4])> + '_ {
        self.puffs.iter().map(|p| {
            let size =
                p.size + p.age * (0.08 + p.range * 0.11 + if p.settled { 0.095 } else { 0. });
            let opacity = (1. - p.age / p.life).powf(1.35) * if p.settled { 0.55 } else { 0.86 };
            (p.position, size, [242, 237, 215, (opacity * 255.) as u8])
        })
    }
}

impl Puff {
    fn advance(&mut self, mut dt: f64) {
        self.age += dt;
        if self.age >= self.life {
            return;
        }
        let forward = self.velocity.dot(self.direction);
        if !self.settled && forward * dt >= self.range - self.travel {
            let impact_time = (self.range - self.travel) / forward.max(1e-5);
            self.position += self.velocity * impact_time;
            self.velocity = (self.velocity - self.direction * forward) * 0.36;
            self.velocity.y += 0.08;
            self.settled = true;
            dt -= impact_time;
        } else {
            self.travel += forward.max(0.) * dt;
        }
        self.position += self.velocity * dt;
        self.velocity *= (-(if self.settled { 4.7 } else { 1.8 }) * dt).exp();
        self.velocity.y -= if self.settled { 0.16 * dt } else { 0.26 * dt };
    }
}
