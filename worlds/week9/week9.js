"use strict"

/*--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
   Things I've added:
   - Move, rotate and scale an object:
      - move left controller close to an object to choose/highlight it
      - hold left trigger (button 1) and move left controller to
        move and rotate the object at will
      - hold right side button (button 2) at the same time and move right
        controller to scale the object
   - Clone an object:
      - move left controller to an object, hold left button 'X' to create an clone
      - keep holding left button 'X' and move left controller to move/rotate the
        clone, release left button 'X' to place it
   - Delete an object:
      - move right controller to an object to highlight it in red
      - simply press right button 'B' to delete the object
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------

The proportions below just happen to match the dimensions of my physical space
and the tables in that space.

Note that I measured everything in inches, and then converted to units of meters
(which is what VR requires) by multiplying by 0.0254.

--------------------------------------------------------------------------------*/

const EYE_HEIGHT = 0.0254 * 69;
const HALL_LENGTH = 0.0254 * 306;
const HALL_WIDTH = 0.0254 * 213;
const TABLE_DEPTH = 0.0254 * 30;
const TABLE_HEIGHT = 0.0254 * 29;
const TABLE_WIDTH = 0.0254 * 60;
const TABLE_THICKNESS = 0.0254 * 11 / 8;
const LEG_THICKNESS = 0.0254 * 2.5;

////////////////////////////// SCENE SPECIFIC CODE

async function setup(state) {
    hotReloadFile(getPath('week9.js'));

    const images = await imgutil.loadImagesPromise([
        getPath("textures/wood.png"),
        getPath("textures/tiles.jpg"),
    ]);

    let libSources = await MREditor.loadAndRegisterShaderLibrariesForLiveEditing(gl, "libs", [
        {key: "pnoise", path: "shaders/noise.glsl", foldDefault: true},
        {key: "sharedlib1", path: "shaders/sharedlib1.glsl", foldDefault: true},
    ]);
    if (!libSources)
        throw new Error("Could not load shader library");

    // load vertex and fragment shaders from the server, register with the editor
    let shaderSource = await MREditor.loadAndRegisterShaderForLiveEditing(
        gl,
        "mainShader",
        {
            onNeedsCompilation: (args, libMap, userData) => {
                const stages = [args.vertex, args.fragment];
                const output = [args.vertex, args.fragment];
                const implicitNoiseInclude = true;
                if (implicitNoiseInclude) {
                    let libCode = MREditor.libMap.get('pnoise');
                    for (let i = 0; i < 2; i++) {
                        const stageCode = stages[i];
                        const hdrEndIdx = stageCode.indexOf(';');
                        const hdr = stageCode.substring(0, hdrEndIdx + 1);
                        output[i] = hdr + '\n#line 2 1\n' +
                            '#include<pnoise>\n#line ' + (hdr.split('\n').length + 1) + ' 0' +
                            stageCode.substring(hdrEndIdx + 1);
                    }
                }
                MREditor.preprocessAndCreateShaderProgramFromStringsAndHandleErrors(
                    output[0],
                    output[1],
                    libMap
                );
            },
            onAfterCompilation: (program) => {
                gl.useProgram(state.program = program);
                state.uColorLoc = gl.getUniformLocation(program, 'uColor');
                state.uCursorLoc = gl.getUniformLocation(program, 'uCursor');
                state.uModelLoc = gl.getUniformLocation(program, 'uModel');
                state.uProjLoc = gl.getUniformLocation(program, 'uProj');
                state.uTexScale = gl.getUniformLocation(program, 'uTexScale');
                state.uTexIndexLoc = gl.getUniformLocation(program, 'uTexIndex');
                state.uTimeLoc = gl.getUniformLocation(program, 'uTime');
                state.uViewLoc = gl.getUniformLocation(program, 'uView');
                state.uTexLoc = [];
                for (let n = 0; n < 8; n++) {
                    state.uTexLoc[n] = gl.getUniformLocation(program, 'uTex' + n);
                    gl.uniform1i(state.uTexLoc[n], n);
                }
            }
        },
        {
            paths: {
                vertex: "shaders/vertex.vert.glsl",
                fragment: "shaders/fragment.frag.glsl"
            },
            foldDefault: {
                vertex: true,
                fragment: false
            }
        }
    );
    if (!shaderSource)
        throw new Error("Could not load shader");

    state.cursor = ScreenCursor.trackCursor(MR.getCanvas());

    state.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);

    let bpe = Float32Array.BYTES_PER_ELEMENT;

    let aPos = gl.getAttribLocation(state.program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, bpe * VERTEX_SIZE, bpe * 0);

    let aNor = gl.getAttribLocation(state.program, 'aNor');
    gl.enableVertexAttribArray(aNor);
    gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, bpe * VERTEX_SIZE, bpe * 3);

    let aUV = gl.getAttribLocation(state.program, 'aUV');
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, bpe * VERTEX_SIZE, bpe * 6);

    for (let i = 0; i < images.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[i]);
        gl.generateMipmap(gl.TEXTURE_2D);
    }
}

let noise = new ImprovedNoise();
let m = new Matrix();
let turnAngle = 0, tiltAngle = 0, cursorPrev = [0, 0, 0];

/*--------------------------------------------------------------------------------

I wrote the following to create an abstraction on top of the left and right
controllers, so that in the onStartFrame() function we can detect press()
and release() events when the user depresses and releases the trigger.

The field detecting the trigger being pressed is buttons[1].pressed.
You can detect pressing of the other buttons by replacing the index 1
by indices 0 through 5.

You might want to try more advanced things with the controllers.
As we discussed in class, there are many more fields in the Gamepad object,
such as linear and angular velocity and acceleration. Using the browser
based debugging tool, you can do something like console.log(leftController)
to see what the options are.

--------------------------------------------------------------------------------*/

function ControllerHandler(controller) {
    this.isDown = (i) => controller.buttons[i].pressed;
    this.onEndFrame = () => {
        for (let i = 0; i < controller.buttons.length; i++)
            wasDown[i] = this.isDown(i);
    }
    this.orientation = () => controller.pose.orientation;
    this.position = () => controller.pose.position;
    this.press = (i) => !wasDown[i] && this.isDown(i);
    this.release = (i) => wasDown[i] && !this.isDown(i);
    this.tip = () => {
        let P = this.position();          // THIS CODE JUST MOVES
        m.identity();                     // THE "HOT SPOT" OF THE
        m.translate(P[0], P[1], P[2]);    // CONTROLLER TOWARD ITS
        m.rotateQ(this.orientation());    // FAR TIP (FURTHER AWAY
        m.translate(0, 0, -.03);  // FROM THE USER'S HAND).
        let v = m.value();
        return [v[12], v[13], v[14]];
    }
    let wasDown = [];
    for (let i = 0; i < controller.buttons.length; i++) {
        wasDown[i] = false;
    }
}

let LC, RC, isNewObj,
    objMoveSelected, objScaleSelected, objCloneSelected;

function onStartFrame(t, state) {

    /*-----------------------------------------------------------------

    Whenever the user enters VR Mode, create the left and right
    controller handlers.

    Also, for my particular use, I have set up a particular transformation
    so that the virtual room would match my physical room, putting the
    resulting matrix into state.calibrate. If you want to do something
    similar, you would need to do a different calculation based on your
    particular physical room.

    -----------------------------------------------------------------*/

    if (MR.VRIsActive()) {
        if (!LC) LC = new ControllerHandler(MR.leftController);
        if (!RC) RC = new ControllerHandler(MR.rightController);

        if (!state.calibrate) {
            m.identity();
            m.rotateY(Math.PI / 2);
            m.translate(-2.01, .04, 0);
            state.calibrate = m.value().slice();
        }
    }

    if (!state.tStart)
        state.tStart = t;
    state.time = (t - state.tStart) / 1000;

    // THIS CURSOR CODE IS ONLY RELEVANT WHEN USING THE BROWSER MOUSE, NOT WHEN IN VR MODE.

    let cursorValue = () => {
        let p = state.cursor.position(), canvas = MR.getCanvas();
        return [p[0] / canvas.clientWidth * 2 - 1, 1 - p[1] / canvas.clientHeight * 2, p[2]];
    }

    let cursorXYZ = cursorValue();
    if (cursorXYZ[2] && cursorPrev[2]) {
        turnAngle -= Math.PI / 2 * (cursorXYZ[0] - cursorPrev[0]);
        tiltAngle += Math.PI / 2 * (cursorXYZ[1] - cursorPrev[1]);
    }
    cursorPrev = cursorXYZ;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.uniform3fv(state.uCursorLoc, cursorXYZ);
    gl.uniform1f(state.uTimeLoc, state.time);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    /*-----------------------------------------------------------------

    Below is the logic for my little toy geometric modeler example.
    You should do something more or different for your assignment. 
    Try modifying the size or color or texture of objects. Try
    deleting objects or adding constraints to make objects align
    when you bring them together. Try adding controls to animate
    objects. There are lots of possibilities.

    -----------------------------------------------------------------*/

    if (LC) {
        // create an object
        if (RC.isDown(1)) {
            menuChoice = findInMenu(RC.position(), LC.tip());
            if (menuChoice >= 0 && LC.press(1)) {
                isNewObj = true;
                let obj = new Obj(menuShape[menuChoice]);
                obj.scale = objBaseScale;
                objs.push(obj);
            }
        }
        if (isNewObj) {
            let obj = objs[objs.length - 1];
            obj.position = LC.tip().slice();
            obj.orientation = LC.orientation().slice();
        }
        if (LC.release(1))
            isNewObj = false;

        // move/rotate/scale an object
        objChoiceLeft = findObj(LC.tip());
        if (objChoiceLeft >= 0 && LC.press(1) && !LC.isDown(2) && !LC.isDown(3) && !LC.isDown(4)) {
            objMoveSelected = true;
            objScaleSelected = true;
        }
        if (objMoveSelected) {
            let obj = objs[objChoiceLeft];
            obj.position = LC.tip().slice();
            obj.orientation = LC.orientation().slice();
        }
        if (objScaleSelected) {
            let obj = objs[objChoiceLeft];
            if (RC.isDown(2))
                obj.scale = scaleObj(LC.tip(), RC.tip());
        }
        if (LC.release(1)) {
            objMoveSelected = false;
            objScaleSelected = false;
        }

        // clone an object
        if (objChoiceLeft >= 0 && LC.press(3) && !LC.isDown(1) && !LC.isDown(2) && !LC.isDown(4)) {
            objCloneSelected = true;
            let obj = objs[objChoiceLeft];
            let objClone = new Obj(obj.shape);
            objClone.scale = obj.scale;
            objs.push(objClone);
        }
        if (objCloneSelected) {
            let obj = objs[objs.length - 1];
            obj.position = LC.tip().slice();
            obj.orientation = LC.orientation().slice();
        }
        if (LC.release(3))
            objCloneSelected = false;

        // delete an object
        objChoiceRight = findObj(RC.tip());
        if (objChoiceRight >= 0 && RC.press(4) && !LC.isDown(1) && !LC.isDown(2) && !LC.isDown(3) &&
            !RC.isDown(1)) {
            objs.splice(objChoiceRight, 1);
        }
    }
}

let objChoiceLeft = -1, objChoiceRight = -1;
let objBaseScale = [.03, .03, .03];

let findObj = (p) => {
    let minDistanceSquare = 10000;
    let objIdx = -1;
    for (let i = 0; i < objs.length; i++) {
        let dx = p[0] - objs[i].position[0];
        let dy = p[1] - objs[i].position[1];
        let dz = p[2] - objs[i].position[2];
        let distanceSquare = dx * dx + dy * dy + dz * dz;
        let radius = (objs[i].scale[0] + objs[i].scale[1] + objs[i].scale[2]) / 3;
        if (distanceSquare < radius * radius && distanceSquare < minDistanceSquare) {
            minDistanceSquare = distanceSquare;
            objIdx = i;
        }
    }
    return objIdx;
};

let scaleObj = (lp, rp) => {
    let sx = Math.abs(lp[0] - rp[0]) * 2 / 3;
    let sy = Math.abs(lp[1] - rp[1]) * 2 / 3;
    let sz = Math.abs(lp[2] - rp[2]) * 2 / 3;
    return [sx, sy, sz];
};

let menuX = [-.2, -.1, -.2, -.1];
let menuY = [.1, .1, 0, 0];
let menuShape = [cube, sphere, cylinder, torus];
let menuChoice = -1;

/*-----------------------------------------------------------------

If the controller tip is near to a menu item, return the index
of that item. If the controller tip is not near to any menu
item, return -1.

mp == position of the menu origin (position of the right controller).
p  == the position of the left controller tip.

-----------------------------------------------------------------*/

let findInMenu = (mp, p) => {
    let x = p[0] - mp[0];
    let y = p[1] - mp[1];
    let z = p[2] - mp[2];
    for (let n = 0; n < 4; n++) {
        let dx = x - menuX[n];
        let dy = y - menuY[n];
        let dz = z;
        if (dx * dx + dy * dy + dz * dz < .03 * .03)
            return n;
    }
    return -1;
};

function Obj(shape) {
    this.shape = shape;
}

let objs = [];

function onDraw(t, projMat, viewMat, state, eyeIdx) {
    gl.uniformMatrix4fv(state.uViewLoc, false, new Float32Array(viewMat));
    gl.uniformMatrix4fv(state.uProjLoc, false, new Float32Array(projMat));

    let prev_shape = null;

    /*-----------------------------------------------------------------

    The drawShape() function below is optimized in that it only downloads
    new vertices to the GPU if the vertices (the "shape" argument) have
    changed since the previous call.

    Also, currently we only draw gl.TRIANGLES if this is a cube. In all
    other cases, we draw gl.TRIANGLE_STRIP. You might want to change
    this if you create other kinds of shapes that are not triangle strips.

    -----------------------------------------------------------------*/

    let drawShape = (shape, color, texture, textureScale) => {
        gl.uniform3fv(state.uColorLoc, color);
        gl.uniformMatrix4fv(state.uModelLoc, false, m.value());
        gl.uniform1i(state.uTexIndexLoc, texture === undefined ? -1 : texture);
        gl.uniform1f(state.uTexScale, textureScale === undefined ? 1 : textureScale);
        if (shape != prev_shape)
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(shape), gl.STATIC_DRAW);
        gl.drawArrays(shape == cube ? gl.TRIANGLES : gl.TRIANGLE_STRIP, 0, shape.length / VERTEX_SIZE);
        prev_shape = shape;
    }

    /*-----------------------------------------------------------------

    In my little toy geometric modeler, the pop-up menu of objects only
    appears while the right controller trigger is pressed. This is just
    an example. Feel free to change things, depending on what you are
    trying to do in your homework.

    -----------------------------------------------------------------*/

    let showMenu = p => {
        let x = p[0], y = p[1], z = p[2];
        for (let n = 0; n < 4; n++) {
            m.save();
            m.translate(x + menuX[n], y + menuY[n], z);
            m.scale(.03, .03, .03);
            drawShape(menuShape[n], n == menuChoice ? [1, .5, .5] : [1, 1, 1]);
            m.restore();
        }
    }

    /*-----------------------------------------------------------------

    drawTable() just happens to model the physical size and shape of the
    tables in my lab (measured in meters). If you want to model physical
    furniture, you will probably want to do something different.

    -----------------------------------------------------------------*/

    let drawTable = () => {
        m.save();
        m.translate(0, TABLE_HEIGHT - TABLE_THICKNESS / 2, 0);
        m.scale(TABLE_DEPTH / 2, TABLE_THICKNESS / 2, TABLE_WIDTH / 2);
        drawShape(cube, [1, 1, 1], 0);
        m.restore();
        m.save();
        let h = (TABLE_HEIGHT - TABLE_THICKNESS) / 2;
        let dx = (TABLE_DEPTH - LEG_THICKNESS) / 2;
        let dz = (TABLE_WIDTH - LEG_THICKNESS) / 2;
        for (let x = -dx; x <= dx; x += 2 * dx)
            for (let z = -dz; z <= dz; z += 2 * dz) {
                m.save();
                m.translate(x, h, z);
                m.scale(LEG_THICKNESS / 2, h, LEG_THICKNESS / 2);
                drawShape(cube, [.5, .5, .5]);
                m.restore();
            }
        m.restore();
    }

    /*-----------------------------------------------------------------

    The below is just my particular "programmer art" for the size and
    shape of a controller. Feel free to create a different appearance
    for the controller. You might also want the controller appearance,
    as well as the way it animates when you press the trigger or other
    buttons, to change with different functionality.

    For example, you might want to have one appearance when using it as
    a selection tool, a resizing tool, a tool for drawing in the air,
    and so forth.

    -----------------------------------------------------------------*/

    let drawController = (C, color) => {
        let P = C.position(), s = C.isDown(1) ? .0125 : .0225;
        m.save();
        m.translate(P[0], P[1], P[2]);
        m.rotateQ(C.orientation());
        m.save();
        m.translate(-s, 0, .001);
        m.scale(.0125, .016, .036);
        drawShape(cube, color);
        m.restore();
        m.save();
        m.translate(s, 0, .001);
        m.scale(.0125, .016, .036);
        drawShape(cube, color);
        m.restore();
        m.save();
        m.translate(0, 0, .025);
        m.scale(.015, .015, .01);
        drawShape(cube, [0, 0, 0]);
        m.restore();
        m.save();
        m.translate(0, 0, .035);
        m.rotateX(.5);
        m.save();
        m.translate(0, -.001, .035);
        m.scale(.014, .014, .042);
        drawShape(cylinder, [0, 0, 0]);
        m.restore();
        m.save();
        m.translate(0, -.001, .077);
        m.scale(.014, .014, .014);
        drawShape(sphere, [0, 0, 0]);
        m.restore();
        m.restore();
        m.restore();
    }

    m.identity();

    /*-----------------------------------------------------------------

    Notice that the actual drawing for my application is done in the
    onDraw() function, whereas the controller logic is done in the
    onStartFrame() function. Whatever your application, it is
    important to make this separation.

    -----------------------------------------------------------------*/

    if (LC) {
        drawController(LC, [1, 0, 0]);
        drawController(RC, [0, 1, 1]);
        if (RC.isDown(1))
            showMenu(RC.position());
    }

    /*-----------------------------------------------------------------

    This is where I draw the objects that have been created.

    If I were to make these objects interactive (that is, responsive
    to the user doing things with the controllers), that logic would
    need to go into onStartFrame(), not here.

    -----------------------------------------------------------------*/

    for (let n = 0; n < objs.length; n++) {
        let obj = objs[n], P = obj.position, s = obj.scale;
        m.save();
        m.translate(P[0], P[1], P[2]);
        m.rotateQ(obj.orientation);
        m.scale(s[0], s[1], s[2]);
        let color = n == objChoiceLeft ? [1, .5, .5] :
            (n == objChoiceRight ? [1, 0, 0] : [1, 1, 1]);
        drawShape(obj.shape, color);
        m.restore();
    }

    if (state.calibrate)
        m.set(state.calibrate);

    m.translate(0, -EYE_HEIGHT, 0);
    m.rotateX(tiltAngle);
    m.rotateY(turnAngle);

    /*-----------------------------------------------------------------

    Notice that I make the room itself as an inside-out cube, by
    scaling x,y and z by negative amounts. This negative scaling
    is a useful general trick for creating interiors.

    -----------------------------------------------------------------*/

    m.save();
    m.translate(0, HALL_WIDTH / 2, 0);
    m.scale(-HALL_WIDTH / 2, -HALL_WIDTH / 2, -HALL_LENGTH / 2);
    drawShape(cube, [1, 1, 1], 1, 2);
    m.restore();

    m.save();
    m.translate((HALL_WIDTH - TABLE_DEPTH) / 2, 0, 0);
    drawTable();
    m.restore();

    m.save();
    m.translate((TABLE_DEPTH - HALL_WIDTH) / 2, 0, 0);
    drawTable();
    m.restore();

}

function onEndFrame(t, state) {

    /*-----------------------------------------------------------------

    The below two lines are necessary for making the controller handler
    logic work properly -- in particular, detecting press() and release()
    actions.

    -----------------------------------------------------------------*/

    if (LC) LC.onEndFrame();
    if (RC) RC.onEndFrame();
}

export default function main() {
    const def = {
        name: 'week9',
        setup: setup,
        onStartFrame: onStartFrame,
        onEndFrame: onEndFrame,
        onDraw: onDraw,
    };
    return def;
}

