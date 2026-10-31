// Export artwork is composed from the same result model as the app, without app controls.
export async function renderVictoryPoster(model, gameUrl) {
  if (!model.canShare) throw new Error('Only participants can share a result poster.');
  await document.fonts.ready;
  await Promise.all([document.fonts.load('600 60px Fraunces'), document.fonts.load('600 30px "DM Sans"')]).catch(() => []);
  const image = new Image(); image.src = model.art; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1560;
  const ctx = canvas.getContext('2d');
  const teal = '#173f40', copper = '#ad7042', parchment = '#f4e8cd';
  // Irregular paper edge and quiet cartography mirror the game's field notes.
  ctx.beginPath();
  const edge = [[23,20],[115,25],[190,18],[284,24],[365,16],[470,23],[560,18],[658,25],[740,17],[850,24],[945,18],[1058,23],[1053,155],[1060,290],[1054,420],[1062,570],[1055,710],[1061,850],[1053,1010],[1060,1150],[1054,1300],[1061,1430],[1055,1537],[950,1532],[840,1540],[730,1534],[620,1542],[510,1535],[400,1540],[290,1532],[180,1539],[85,1534],[20,1540],[26,1400],[18,1250],[25,1100],[18,940],[26,790],[20,640],[27,480],[18,320],[25,170]];
  edge.forEach(([x,y],i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.closePath(); ctx.clip();
  const paper = ctx.createLinearGradient(0,0,1080,1560); paper.addColorStop(0,'#f6ecd7'); paper.addColorStop(.5,parchment); paper.addColorStop(1,'#e8d5b2');
  ctx.fillStyle = paper; ctx.fillRect(0,0,1080,1560);
  ctx.fillStyle = '#8662390b';
  for (let i=0;i<7000;i++) { const x=(i*739)%1080, y=(i*997)%1560; ctx.fillRect(x,y,1+(i%3),1); }
  ctx.save(); ctx.strokeStyle = '#8d845319'; ctx.lineWidth = 1;
  for (let i=0;i<7;i++) { ctx.beginPath(); ctx.ellipse(1060,1400,100+i*24,180+i*37,-.5,0,Math.PI*2); ctx.stroke(); }
  ctx.setLineDash([5,9]); ctx.beginPath(); ctx.moveTo(55,180); ctx.bezierCurveTo(180,100,850,380,1030,135); ctx.stroke(); ctx.restore();
  function fitText(value, x, y, width, height, size, family = 'DM Sans', color = teal) {
    function wrap(text) {
      const lines = []; let line = '';
      for (const word of String(text).split(' ')) {
        if (line && ctx.measureText(`${line} ${word}`).width > width) { lines.push(line); line = ''; }
        for (const char of (line ? ' ' : '') + word) {
          if (ctx.measureText(line + char).width > width) { lines.push(line); line = ''; }
          line += char;
        }
      }
      if (line) lines.push(line);
      return lines;
    }
    let lines;
    do { ctx.font = `600 ${size}px "${family}"`; lines = wrap(value); if (lines.length * size * 1.22 <= height) break; size -= 1; } while (size > 12);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
    const first = y + (height - lines.length * size * 1.22) / 2 + size * .61;
    lines.forEach((line,i) => ctx.fillText(line, x, first + i * size * 1.22));
  }
  fitText('TreasureHunch', 540, 58, 900, 65, 47, 'Fraunces');
  fitText('✦  FROM THE RIVALRY LOG  ✦',540,111,880,20,14,'DM Sans',copper);
  fitText(model.challenge.toLocaleUpperCase(), 540, 135, 880, 55, 24);
  fitText(`${model.hider} · Hider`, 310, 190, 400, 60, 25, 'Fraunces');
  fitText('→', 540, 190, 40, 60, 30, 'Fraunces', copper);
  fitText(`${model.seeker} · Seeker`, 770, 190, 400, 60, 25, 'Fraunces');
  // Original illustration fills the hero area; a parchment fade joins it to the typography.
  ctx.drawImage(image, 52, 260, 976, 650);
  const topFade = ctx.createLinearGradient(0,260,0,310); topFade.addColorStop(0,'#f4e8cd'); topFade.addColorStop(1,'#f4e8cd00'); ctx.fillStyle=topFade; ctx.fillRect(52,260,976,50);
  const fade = ctx.createLinearGradient(0, 835, 0, 920); fade.addColorStop(0, '#f4e8cd00'); fade.addColorStop(1, parchment);
  ctx.fillStyle = fade; ctx.fillRect(52, 835, 976, 85);
  fitText(model.seekerWon ? 'HIDER OUTSMARTED' : 'HIDER WINS', 540, 919, 900, 38, 22, 'DM Sans', copper);
  fitText(model.seekerWon ? 'Nice hiding. Better seeking.' : 'The treasure kept its secret.', 540, 968, 910, 115, 64, 'Fraunces');
  fitText(model.story, 540, 1090, 880, 95, 32, 'Fraunces');
  fitText(`TREASURE: ${model.country || 'Location unavailable'}`, 540, 1190, 880, 45, 24, 'DM Sans', copper);
  ctx.strokeStyle = '#a88a5e66'; ctx.beginPath(); ctx.moveTo(100,1250); ctx.lineTo(980,1253); ctx.moveTo(100,1383); ctx.lineTo(980,1380); ctx.stroke();
  for (const [i, value, label] of [[0, `${model.timeUsed}s`, 'TIME USED'], [1, `${model.clues}/3`, 'CLUES OPENED'], [2, model.wrongGuesses, 'WRONG GUESSES']]) {
    const x = 233 + i * 307;
    if (i) { ctx.beginPath(); ctx.moveTo(x - 153, 1278); ctx.lineTo(x - 153, 1357); ctx.stroke(); }
    fitText(value, x, 1266, 280, 65, 46, 'Fraunces'); fitText(label, x, 1333, 280, 30, 18);
  }
  fitText(`Includes time costs · ${model.roundSeconds}s hunt`, 540, 1390, 880, 30, 18);
  fitText('Hide a treasure. Challenge a rival.', 540, 1431, 880, 35, 26, 'Fraunces');
  fitText(gameUrl, 540, 1475, 900, 30, 20, 'DM Sans', copper);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The poster could not be created.')), 'image/png'));
}

export async function sharePosterFile(blob, code, platform = navigator, download = downloadPoster) {
  const file = new File([blob], `treasurehunch-${code}.png`, { type: 'image/png' });
  if (platform.share && platform.canShare?.({ files: [file] })) {
    try { await platform.share({ files: [file], title: 'TreasureHunch challenge result' }); return 'shared'; }
    catch (error) { if (error.name === 'AbortError') return 'cancelled'; }
  }
  download(file); return 'downloaded';
}
function downloadPoster(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a'); link.href = url; link.download = file.name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
