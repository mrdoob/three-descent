// Ported from: descent-master/MAIN/CONTROLS.C
// Input controls: keyboard, mouse, pointer lock

// Input state
const keys = {};
let mouseX = 0;
let mouseY = 0;
let wheelDelta = 0;
let isPointerLocked = false;

// Weapon firing state
let fireButtonDown = false;
let secondaryFireButtonDown = false;

// Callback for key actions (weapon selection, automap toggle)
let _onKeyAction = null;

export function controls_set_key_action_callback( cb ) {

	_onKeyAction = cb;

}

// Initialize input handlers
export function controls_init( domElement ) {

	window.addEventListener( 'keydown', onKeyDown );
	window.addEventListener( 'keyup', onKeyUp );
	window.addEventListener( 'resize', onResize );

	domElement.addEventListener( 'click', () => {

		domElement.requestPointerLock();

	} );

	// Prevent context menu on right-click (used for secondary fire)
	domElement.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );

	document.addEventListener( 'pointerlockchange', () => {

		isPointerLocked = ( document.pointerLockElement === domElement );

	} );

	document.addEventListener( 'mousemove', onMouseMove );
	document.addEventListener( 'wheel', onWheel, { passive: false } );

	// Fire button (left mouse)
	document.addEventListener( 'mousedown', onMouseDown );
	document.addEventListener( 'mouseup', onMouseUp );

}

// External references for resize
let _camera = null;
let _renderer = null;

export function controls_set_resize_refs( camera, renderer ) {

	_camera = camera;
	_renderer = renderer;

}

// --- Getters ---

export function controls_get_keys() { return keys; }
export function controls_get_mouse_x() { return mouseX; }
export function controls_get_mouse_y() { return mouseY; }
export function controls_is_pointer_locked() { return isPointerLocked; }
export function controls_is_fire_down() { return fireButtonDown; }
export function controls_is_secondary_fire_down() { return secondaryFireButtonDown; }
export function controls_set_secondary_fire_down( v ) { secondaryFireButtonDown = v; }
export function controls_consume_wheel() { const d = wheelDelta; wheelDelta = 0; return d; }

// Consume mouse delta (reset after reading)
// Pre-allocated result object to avoid per-frame allocation (Golden Rule #5)
const _mouseResult = { x: 0, y: 0 };

export function controls_consume_mouse() {

	_mouseResult.x = mouseX;
	_mouseResult.y = mouseY;
	mouseX = 0;
	mouseY = 0;
	return _mouseResult;

}

// --- Event handlers ---

function onKeyDown( e ) {

	keys[ e.code ] = true;

	// Delegate key actions (weapon selection, automap) to game.js callback
	if ( _onKeyAction !== null ) {

		_onKeyAction( e );

	}

}

function onKeyUp( e ) {

	keys[ e.code ] = false;

}

function onMouseDown( e ) {

	if ( isPointerLocked === true && e.button === 0 ) {

		fireButtonDown = true;

	}

	// Right-click fires secondary weapon
	if ( isPointerLocked === true && e.button === 2 ) {

		secondaryFireButtonDown = true;

	}

}

function onMouseUp( e ) {

	if ( e.button === 0 ) {

		fireButtonDown = false;

	}

}

function onResize() {

	if ( _camera === null || _renderer === null ) return;

	_camera.aspect = window.innerWidth / window.innerHeight;
	_camera.updateProjectionMatrix();
	_renderer.setSize( window.innerWidth, window.innerHeight );

}

function onMouseMove( e ) {

	if ( isPointerLocked === true ) {

		mouseX += e.movementX;
		mouseY += e.movementY;

	}

}

function onWheel( e ) {

	wheelDelta += e.deltaY;
	e.preventDefault();

}
