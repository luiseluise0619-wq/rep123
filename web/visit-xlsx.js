(function(root){
'use strict';
const encoder=new TextEncoder();
function xml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));}
function col(index){let value=index+1,text='';while(value){value--;text=String.fromCharCode(65+value%26)+text;value=Math.floor(value/26);}return text;}
function sheet(rows){
  const body=rows.map((row,r)=>'<row r="'+(r+1)+'">'+row.map((value,c)=>{
    const ref=col(c)+(r+1),style=r===0?' s="1"':'';
    return typeof value==='number'&&Number.isFinite(value)?'<c r="'+ref+'"'+style+'><v>'+value+'</v></c>':
      '<c r="'+ref+'"'+style+' t="inlineStr"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>';
  }).join('')+'</row>').join('');
  const last=rows.length?col(Math.max(0,rows[0].length-1))+rows.length:'A1';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'+ 
    '<sheetData>'+body+'</sheetData><autoFilter ref="A1:'+last+'"/></worksheet>';
}
let crcTable;
function crc32(bytes){
  if(!crcTable)crcTable=Array.from({length:256},(_,n)=>{let value=n;for(let i=0;i<8;i++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
  let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;
}
function concat(parts){const length=parts.reduce((n,part)=>n+part.length,0),out=new Uint8Array(length);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;}
function header(length,write){const bytes=new Uint8Array(length),view=new DataView(bytes.buffer);write(view);return bytes;}
function zip(files){
  const local=[],central=[];let offset=0;
  for(const [name,content] of Object.entries(files)){
    const path=encoder.encode(name),bytes=encoder.encode(content),crc=crc32(bytes);
    const first=header(30,view=>{view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint32(14,crc,true);view.setUint32(18,bytes.length,true);view.setUint32(22,bytes.length,true);view.setUint16(26,path.length,true);});
    local.push(first,path,bytes);
    const entry=header(46,view=>{view.setUint32(0,0x02014b50,true);view.setUint16(4,20,true);view.setUint16(6,20,true);view.setUint32(16,crc,true);view.setUint32(20,bytes.length,true);view.setUint32(24,bytes.length,true);view.setUint16(28,path.length,true);view.setUint32(42,offset,true);});
    central.push(entry,path);offset+=first.length+path.length+bytes.length;
  }
  const directory=concat(central),end=header(22,view=>{view.setUint32(0,0x06054b50,true);view.setUint16(8,Object.keys(files).length,true);view.setUint16(10,Object.keys(files).length,true);view.setUint32(12,directory.length,true);view.setUint32(16,offset,true);});
  return concat([...local,directory,end]);
}
function makeWorkbook(sheets){
  if(!Array.isArray(sheets)||!sheets.length||sheets.length>10)throw Error('시트 구성이 올바르지 않습니다.');
  const files={
    '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+sheets.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'</Types>',
    '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+sheets.map((item,i)=>'<sheet name="'+xml(item.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'<Relationship Id="rId'+(sheets.length+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':'<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF2FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
  };
  sheets.forEach((item,i)=>{files['xl/worksheets/sheet'+(i+1)+'.xml']=sheet(item.rows);});
  return zip(files);
}
function download(sheets,filename){
  const bytes=makeWorkbook(sheets),url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const api={makeWorkbook,download};
if(typeof module==='object'&&module.exports)module.exports=api;
else root.VisitXlsx=api;
})(typeof window!=='undefined'?window:globalThis);
