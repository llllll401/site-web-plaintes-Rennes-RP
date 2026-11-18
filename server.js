import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import { createHmac, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.UPLOAD_DIR || '/var/data/uploads';
const COOKIE = 'rrp_staff';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : true });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL est requis.');
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET doit contenir au moins 32 caractères.');
if (!process.env.STAFF_ACCESS_CODE || process.env.STAFF_ACCESS_CODE.length < 16) throw new Error('STAFF_ACCESS_CODE doit contenir au moins 16 caractères.');
await mkdir(DATA_DIR, { recursive: true });

await pool.query(`CREATE TABLE IF NOT EXISTS reports (
 id UUID PRIMARY KEY, roblox VARCHAR(50) NOT NULL, discord VARCHAR(100) NOT NULL,
 details VARCHAR(5000) NOT NULL, files JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 claimed_by VARCHAR(80), claimed_at TIMESTAMPTZ
)`);

const safeEqual = (left, right) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
const sign = value => createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('base64url');
function getStaff(req) {
  const value = req.cookies?.[COOKIE]; if (!value) return null;
  const dot = value.lastIndexOf('.'); if (dot < 1) return null;
  const payload = value.slice(0, dot), mac = value.slice(dot + 1);
  if (!safeEqual(sign(payload), mac)) return null;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return data.exp > Date.now() ? data.name : null; } catch { return null; }
}
function requireStaff(req, res, next) { const staff = getStaff(req); if (!staff) return res.status(401).json({ error: 'Connexion staff requise.' }); req.staff = staff; next(); }
function sameOrigin(req, res, next) { const origin = req.get('origin'); if (origin) { try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origine non autorisée.' }); } catch { return res.status(403).json({ error: 'Origine non autorisée.' }); } } next(); }
app.disable('x-powered-by'); app.set('trust proxy', 1);
app.use((req, res, next) => { res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','strict-origin-when-cross-origin');res.set('X-Frame-Options','DENY');res.set('Cache-Control','no-store');next(); });
app.use(express.json({ limit: '4kb' }));
app.use((req,res,next)=>{req.cookies={};for(const pair of (req.headers.cookie||'').split(';')){const i=pair.indexOf('=');if(i>0)req.cookies[pair.slice(0,i).trim()]=decodeURIComponent(pair.slice(i+1).trim())}next()});
app.use('/api', sameOrigin);
const loginLimiter=rateLimit({windowMs:15*60_000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Trop de tentatives. Réessayez dans 15 minutes.'}});
app.post('/api/login',loginLimiter,(req,res)=>{
 const code=typeof req.body?.code==='string'?req.body.code:'';if(!safeEqual(code,process.env.STAFF_ACCESS_CODE))return res.status(401).json({error:'Code incorrect.'});
 const payload=Buffer.from(JSON.stringify({name:`Staff-${randomBytes(3).toString('hex')}`,exp:Date.now()+SESSION_TTL})).toString('base64url');res.cookie(COOKIE,`${payload}.${sign(payload)}`,{httpOnly:true,secure:true,sameSite:'strict',path:'/',maxAge:SESSION_TTL});res.json({ok:true});
});
app.post('/api/logout',(req,res)=>{res.clearCookie(COOKIE,{httpOnly:true,secure:true,sameSite:'strict',path:'/'});res.json({ok:true})});
app.get('/api/session',(req,res)=>res.json({staff:!!getStaff(req)}));
const storage=multer.diskStorage({destination:(_req,_file,cb)=>cb(null,DATA_DIR),filename:(_req,file,cb)=>cb(null,randomUUID())});
const upload=multer({storage,fileFilter:(_req,file,cb)=>{const type=file.mimetype||'';cb(/^(image|video|audio)\//i.test(type)?null:new Error('Type de fichier non autorisé.'));}}).array('files');
const removeUploads=async files=>Promise.all((files||[]).map(f=>unlink(f.path).catch(()=>{})));
app.post('/api/reports',(req,res)=>upload(req,res,async err=>{
 if(err){await removeUploads(req.files);return res.status(400).json({error:'Impossible de recevoir ces fichiers. Vérifiez leur type et l’espace disque disponible.'})}
 const files=req.files||[];try{const roblox=String(req.body.roblox||'').trim(),discord=String(req.body.discord||'').trim(),details=String(req.body.details||'').trim();if(!roblox||roblox.length>50||!discord||discord.length>100||!details||details.length>5000){await removeUploads(files);return res.status(400).json({error:'Vérifiez les champs obligatoires et leurs longueurs.'})}
 const id=randomUUID(),metadata=files.map(f=>({key:path.basename(f.filename),name:path.basename(f.originalname||'preuve').replace(/[\x00-\x1f\\/]/g,'_').slice(0,130)||'preuve',type:f.mimetype,size:f.size}));await pool.query('INSERT INTO reports(id,roblox,discord,details,files) VALUES($1,$2,$3,$4,$5)',[id,roblox,discord,details,JSON.stringify(metadata)]);res.status(201).json({ok:true,id});
 }catch(e){await removeUploads(files);console.error('submit report:',e);res.status(500).json({error:'Impossible d’enregistrer le signalement.'})}
}));
app.get('/api/reports',requireStaff,async(req,res)=>{try{const {rows}=await pool.query('SELECT id,roblox,discord,details,files,created_at AS "createdAt",claimed_by AS "claimedBy" FROM reports ORDER BY created_at DESC');res.json({reports:rows.map(r=>({...r,viewer:req.staff}))})}catch(e){console.error(e);res.status(500).json({error:'Erreur de lecture des dossiers.'})}});
app.post('/api/reports/:id/claim',requireStaff,async(req,res)=>{try{const result=await pool.query('UPDATE reports SET claimed_by=$1,claimed_at=NOW() WHERE id=$2 AND claimed_by IS NULL RETURNING id', [req.staff,req.params.id]);if(!result.rowCount){const existing=await pool.query('SELECT claimed_by FROM reports WHERE id=$1',[req.params.id]);return res.status(existing.rowCount?409:404).json({error:existing.rowCount?'Ce dossier est déjà pris en charge.':'Dossier introuvable.'})}res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Impossible de prendre en charge le dossier.'})}});
app.post('/api/reports/:id/release',requireStaff,async(req,res)=>{try{const result=await pool.query('UPDATE reports SET claimed_by=NULL,claimed_at=NULL WHERE id=$1 AND claimed_by=$2 RETURNING id',[req.params.id,req.staff]);if(!result.rowCount){const exists=await pool.query('SELECT id FROM reports WHERE id=$1',[req.params.id]);return res.status(exists.rowCount?409:404).json({error:exists.rowCount?'Seul le responsable actuel peut libérer ce dossier.':'Dossier introuvable.'})}res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Impossible de libérer le dossier.'})}});
app.post('/api/reports/:id/resolve',requireStaff,async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const found=await client.query('SELECT files FROM reports WHERE id=$1 AND claimed_by=$2 FOR UPDATE',[req.params.id,req.staff]);if(!found.rowCount){await client.query('ROLLBACK');const exists=await pool.query('SELECT id FROM reports WHERE id=$1',[req.params.id]);return res.status(exists.rowCount?409:404).json({error:exists.rowCount?'Seul le responsable actuel peut traiter ce dossier.':'Dossier introuvable.'})}await client.query('DELETE FROM reports WHERE id=$1',[req.params.id]);await client.query('COMMIT');await removeUploads((found.rows[0].files||[]).map(f=>({path:path.join(DATA_DIR,path.basename(f.key))})));res.json({ok:true})}catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(e);res.status(500).json({error:'Impossible de traiter le dossier.'})}finally{client.release()}});
app.get('/api/files/:id/:key',requireStaff,async(req,res)=>{try{const {rows}=await pool.query('SELECT files FROM reports WHERE id=$1',[req.params.id]);const f=rows[0]?.files?.find(x=>x.key===req.params.key);if(!f)return res.status(404).json({error:'Fichier introuvable.'});res.set('Content-Security-Policy',"default-src 'none'; sandbox");res.set('Content-Disposition',`inline; filename="${f.name.replace(/["\\\r\n]/g,'_')}"`);res.type(f.type);res.sendFile(path.join(DATA_DIR,path.basename(f.key)),err=>{if(err&&!res.headersSent)res.status(404).end()})}catch(e){console.error(e);res.status(500).json({error:'Erreur de lecture du fichier.'})}});
app.use('/api',(req,res)=>res.status(404).json({error:'Route introuvable.'}));
app.get('/',(_req,res)=>res.set('Cache-Control','no-cache').sendFile(path.join(process.cwd(),'index.html')));
app.use((_req,res)=>res.status(404).send('Introuvable'));
app.listen(PORT,'0.0.0.0',()=>console.log(`Rennes RP écoute sur ${PORT}`));
