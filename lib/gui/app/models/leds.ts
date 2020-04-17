/*
 * Copyright 2020 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AnimationFunction, Color, RGBLed } from 'sys-class-rgb-led';

import { isSourceDrive } from '../../../shared/drive-constraints';
import * as settings from './settings';
import { observe } from './store';

const leds: Map<string, RGBLed> = new Map();

function setLeds(
	drivesPaths: Set<string>,
	colorOrAnimation: Color | AnimationFunction,
) {
	for (const path of drivesPaths) {
		const led = leds.get(path);
		if (led) {
			if (Array.isArray(colorOrAnimation)) {
				led.setStaticColor(colorOrAnimation);
			} else {
				led.setAnimation(colorOrAnimation);
			}
		}
	}
}

const red: Color = [1, 0, 0];
const green: Color = [0, 1, 0];
const blue: Color = [0, 0, 1];
const white: Color = [1, 1, 1];
const black: Color = [0, 0, 0];

function breatheBlue(t: number): Color {
	const intensity = (1 + Math.sin(t / 1000)) / 2;
	return [0, 0, intensity];
}

function blinkGreen(t: number): Color {
	const intensity = Math.floor(t / 1000) % 2;
	return [0, intensity, 0];
}

function blinkPurple(t: number): Color {
	const intensity = Math.floor(t / 1000) % 2;
	return [intensity / 2, 0, intensity];
}

// Source slot (1st slot): behaves as a target unless it is chosen as source
//  No drive: black
//  Drive plugged: blue - on
//
// Other slots (2 - 16):
//
// +----------------+---------------+----------------------------+-----------------------------+---------------------------------+
// |                | main screen   | flashing                   | validating                  | results screen                  |
// +----------------+---------------+----------------------------+-----------------------------+---------------------------------+
// | no drive       | black         | black                      | black                       | black                           |
// +----------------+---------------+----------------------------+-----------------------------+---------------------------------+
// | drive plugged  | black         | black                      | black                       | black                           |
// +----------------+---------------+----------------------------+-----------------------------+---------------------------------+
// | drive selected | white         | blink green, red if failed | blink purple, red if failed | green if success, red if failed |
// +----------------+---------------+----------------------------+-----------------------------+---------------------------------+
export function updateLeds(
	step: 'main' | 'flashing' | 'verifying' | 'finish',
	sourceDrivePath: string | undefined,
	availableDrives: string[],
	selectedDrives: string[],
	failedDrives: string[],
) {
	const unplugged = new Set(leds.keys());
	const plugged = new Set(availableDrives);
	const selectedOk = new Set(selectedDrives);
	const selectedFailed = new Set(failedDrives);

	// Remove selected devices from plugged set
	for (const d of selectedOk) {
		plugged.delete(d);
	}

	// Remove plugged devices from unplugged set
	for (const d of plugged) {
		unplugged.delete(d);
	}

	// Remove failed devices from selected set
	for (const d of selectedFailed) {
		selectedOk.delete(d);
	}

	// Handle source slot
	if (sourceDrivePath !== undefined) {
		if (unplugged.has(sourceDrivePath)) {
			unplugged.delete(sourceDrivePath);
			setLeds(new Set([sourceDrivePath]), breatheBlue);
		} else if (plugged.has(sourceDrivePath)) {
			plugged.delete(sourceDrivePath);
			setLeds(new Set([sourceDrivePath]), blue);
		}
	}
	console.log('step', step, unplugged, plugged, selectedOk, selectedFailed);

	if (step === 'main') {
		setLeds(unplugged, black);
		setLeds(plugged, black);
		setLeds(selectedOk, white);
		setLeds(selectedFailed, white);
	} else if (step === 'flashing') {
		setLeds(unplugged, black);
		setLeds(plugged, black);
		setLeds(selectedOk, blinkGreen);
		setLeds(selectedFailed, red);
	} else if (step === 'verifying') {
		setLeds(unplugged, black);
		setLeds(plugged, black);
		setLeds(selectedOk, blinkPurple);
		setLeds(selectedFailed, red);
	} else if (step === 'finish') {
		setLeds(unplugged, black);
		setLeds(plugged, black);
		setLeds(selectedOk, green);
		setLeds(selectedFailed, red);
	}
}

interface DeviceFromState {
	devicePath?: string;
	device: string;
}

export function init() {
	// ledsMapping is something like:
	// {
	// 	'platform-xhci-hcd.0.auto-usb-0:1.1.1:1.0-scsi-0:0:0:0': [
	// 		'led1_r',
	// 		'led1_g',
	// 		'led1_b',
	// 	],
	// 	...
	// }
	const ledsMapping: _.Dictionary<[string, string, string]> =
		settings.get('ledsMapping') || {};
	for (const [drivePath, ledsNames] of Object.entries(ledsMapping)) {
		leds.set('/dev/disk/by-path/' + drivePath, new RGBLed(ledsNames));
	}
	observe(state => {
		const s = state.toJS();
		let step: 'main' | 'flashing' | 'verifying' | 'finish';
		if (s.isFlashing) {
			step = s.flashState.flashing > 0 ? 'flashing' : 'verifying';
		} else {
			step = s.lastAverageFlashingSpeed == null ? 'main' : 'finish';
		}
		console.log('new state', s);
		const availableDrives = s.availableDrives.filter(
			(d: DeviceFromState) => d.devicePath,
		);
		const sourceDrivePath = availableDrives.filter(isSourceDrive)[0]
			?.devicePath;
		const availableDrivesPaths = availableDrives.map(
			(d: DeviceFromState) => d.devicePath,
		);
		function getDrivesPaths(drives: string[]): string[] {
			return availableDrives
				.filter((d: DeviceFromState) => drives.includes(d.device))
				.map((d: DeviceFromState) => d.devicePath);
		}
		// s.selection.devices is a list of strings like "/dev/sda"
		const selectedDrivesPaths = getDrivesPaths(s.selection.devices);
		const failedDrives =
			s.flashResults?.results?.errors?.map(
				(e: { device: string }) => e.device,
			) || [];
		const failedDrivesPaths = getDrivesPaths(failedDrives);
		updateLeds(
			step,
			sourceDrivePath,
			availableDrivesPaths,
			selectedDrivesPaths,
			failedDrivesPaths,
		);
	});
}
