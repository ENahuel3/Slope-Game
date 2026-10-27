"""Compare cached overlay state with native WebGL state after binds and deletion.
Run with the project's Playwright environment: python tools/gl_state_check.py .
"""
import pathlib, sys
from playwright.sync_api import sync_playwright
root=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    page=browser.new_page()
    page.add_script_tag(path=str(root/'TemplateData/gl-state.js'))
    result=page.evaluate('''async () => {
      const failures=[], passed=[];
      for(const type of ['webgl','webgl2']) {
        const canvas=document.createElement('canvas'), gl=canvas.getContext(type);
        if(!gl) { failures.push(type+' unavailable'); continue; }
        const check=label=>{
          const bad=SlopeGLState.audit(gl), err=gl.getError();
          if(bad.length||err) failures.push(type+' '+label+': '+bad+' error='+err);
          else passed.push(type+' '+label);
        };
        // Prime the cache before mutations.
        for(const key of ['CURRENT_PROGRAM','FRAMEBUFFER_BINDING','ARRAY_BUFFER_BINDING','ACTIVE_TEXTURE','VIEWPORT','COLOR_WRITEMASK','RENDERBUFFER_BINDING','DEPTH_FUNC','DEPTH_WRITEMASK','CULL_FACE_MODE','FRONT_FACE','BLEND_SRC_RGB','BLEND_DST_RGB','BLEND_SRC_ALPHA','BLEND_DST_ALPHA','UNPACK_FLIP_Y_WEBGL','UNPACK_PREMULTIPLY_ALPHA_WEBGL']) gl.getParameter(gl[key]);
        gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthFunc(gl.GEQUAL); gl.depthMask(false);
        gl.cullFace(gl.FRONT); gl.frontFace(gl.CW); gl.viewport(3,4,100,80); gl.colorMask(false,true,true,false);
        gl.blendFuncSeparate(gl.ONE,gl.ZERO,gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
        check('scalar, vector and enabled state');
        const v=gl.getParameter(gl.VIEWPORT); v[0]=999;
        if(gl.getParameter(gl.VIEWPORT)[0]!==3) failures.push(type+' mutable query leaked into cache');
        const textures=[];
        for(let i=0;i<4;i++) {
          gl.activeTexture(gl.TEXTURE0+i); const t=gl.createTexture(); textures.push(t); gl.bindTexture(gl.TEXTURE_2D,t);
          if(gl.getParameter(gl.TEXTURE_BINDING_2D)!==t) failures.push(type+' texture unit '+i);
          if(type==='webgl2') { const s=gl.createSampler(); gl.bindSampler(i,s); if(gl.getParameter(gl.SAMPLER_BINDING)!==s) failures.push('sampler '+i); }
        }
        check('texture units and samplers');
        const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf); gl.bufferData(gl.ARRAY_BUFFER,128,gl.STATIC_DRAW);
        check('array buffer'); gl.deleteBuffer(buf); check('deleted bound array buffer');
        gl.deleteTexture(textures[3]); check('deleted bound texture');
        const fb=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,fb); check('framebuffer');
        if(type==='webgl2') {
          const read=gl.createFramebuffer(); gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read); check('separate read/draw framebuffer');
          gl.deleteFramebuffer(read); check('deleted read framebuffer');
          const vao=gl.createVertexArray(); gl.bindVertexArray(vao); check('vertex array'); gl.deleteVertexArray(vao);check('deleted vertex array');
          for(const target of [gl.PIXEL_UNPACK_BUFFER,gl.PIXEL_PACK_BUFFER]) { const b=gl.createBuffer(); gl.bindBuffer(target,b); check('pixel buffer');gl.deleteBuffer(b);check('deleted pixel buffer'); }
        } else {
          const ext=gl.getExtension('OES_vertex_array_object');
          if(ext) { const vao=ext.createVertexArrayOES();ext.bindVertexArrayOES(vao);check('OES vertex array');ext.deleteVertexArrayOES(vao);check('deleted OES vertex array'); }
        }
        gl.deleteFramebuffer(fb);check('deleted framebuffer');
        const rb=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,rb);check('renderbuffer');gl.deleteRenderbuffer(rb);check('deleted renderbuffer');
        const loss=gl.getExtension('WEBGL_lose_context');
        if(loss) {
          const lost=new Promise(resolve=>canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();resolve();},{once:true}));
          loss.loseContext();await lost;
          if(gl.getParameter(gl.VIEWPORT)!==null) failures.push(type+' lost context returned stale viewport');
          const restored=new Promise(resolve=>canvas.addEventListener('webglcontextrestored',resolve,{once:true}));
          await new Promise(resolve=>setTimeout(resolve,50));loss.restoreContext();
          await Promise.race([restored,new Promise((_,reject)=>setTimeout(()=>reject(Error('context restore timeout')),3000))]);
          gl.getParameter(gl.VIEWPORT);gl.isEnabled(gl.BLEND);check('context loss and restoration');
        }
      }
      return {passed,failures};
    }''')
    for name in result['passed']: print('PASS',name)
    for name in result['failures']: print('FAIL',name)
    browser.close()
    sys.exit(bool(result['failures']))
