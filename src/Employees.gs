/**
 * Employee records. There is no password column. Access is granted only
 * after a verified Google identity matches an active employee email.
 */

function getSession(request) {
  var actor = rhRequireActor_(request, {
    roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'],
    action: 'SESSION'
  });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var employee = rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.EMPLOYEES, 'employee_id', actor.employee_id),
      'Employee was not found'
    );
    var location = null;
    if (actor.location_id) location = rhPublicLocation_(rhRequireLocation_(ctx, actor.location_id));
    return {
      employee: rhPublicEmployee_(employee),
      location: location,
      money_unit: RH_MONEY_UNIT
    };
  });
}

function createEmployee(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN'], action: 'EMPLOYEE_CREATE' });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var fullName = rhRequireText_(request.fullName, 'fullName', 2, 120);
    var email = rhNormalizeEmail_(request.email);
    var role = rhRequireEnum_(request.role, RH_ROLES, 'role');
    var locationId = rhEmployeeLocationForRole_(ctx, role, request.locationId);
    var isActive = request.isActive === undefined ? true : rhRequireBoolean_(request.isActive, 'isActive');
    if (rhFindBy_(ctx, RH_SHEET.EMPLOYEES, 'email', email).length) {
      throw rhFail_('CONFLICT', 'An employee with that email already exists');
    }
    var now = rhNowIso_();
    var employee = rhAppendRecord_(ctx, RH_SHEET.EMPLOYEES, {
      employee_id: rhNewId_(),
      full_name: fullName,
      email: email,
      role: role,
      location_id: locationId,
      is_active: isActive,
      created_at: now,
      updated_at: now
    });
    rhAudit_(ctx, {
      employee_id: actor.employee_id,
      action: 'EMPLOYEE_CREATED',
      entity_type: 'EMPLOYEE',
      entity_id: employee.employee_id,
      details: { role: role, location_id: locationId, is_active: isActive }
    });
    return rhPublicEmployee_(employee);
  });
}

function updateEmployeeAccess(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN'], action: 'EMPLOYEE_ACCESS_CHANGE' });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var employeeId = rhRequireUuid_(request.employeeId, 'employeeId');
    var current = rhRequireSingle_(
      rhFindBy_(ctx, RH_SHEET.EMPLOYEES, 'employee_id', employeeId),
      'Employee was not found'
    );
    var hasRole = Object.prototype.hasOwnProperty.call(request, 'role');
    var hasLocation = Object.prototype.hasOwnProperty.call(request, 'locationId');
    var hasActive = Object.prototype.hasOwnProperty.call(request, 'isActive');
    if (!hasRole && !hasLocation && !hasActive) {
      throw rhFail_('VALIDATION', 'Provide a role, location, or active flag to change');
    }
    var role = hasRole ? rhRequireEnum_(request.role, RH_ROLES, 'role') : current.role;
    var isActive = hasActive ? rhRequireBoolean_(request.isActive, 'isActive') : current.is_active;
    var locationId = hasLocation
      ? rhEmployeeLocationForRole_(ctx, role, request.locationId)
      : rhEmployeeLocationForRole_(ctx, role, current.location_id);
    if (current.role === 'ADMIN' && current.is_active === true && (role !== 'ADMIN' || isActive !== true)) {
      if (rhCountOtherActiveAdmins_(ctx, current.employee_id) < 1) {
        throw rhFail_('INVALID_STATE', 'The last active admin cannot be removed');
      }
    }
    var updated = rhUpdateRecord_(ctx, RH_SHEET.EMPLOYEES, current._row, current, {
      role: role,
      location_id: locationId,
      is_active: isActive,
      updated_at: rhNowIso_()
    });
    rhAudit_(ctx, {
      employee_id: actor.employee_id,
      action: 'EMPLOYEE_ACCESS_CHANGED',
      entity_type: 'EMPLOYEE',
      entity_id: current.employee_id,
      details: {
        before: { role: current.role, location_id: current.location_id, is_active: current.is_active },
        after: { role: role, location_id: locationId, is_active: isActive }
      }
    });
    return rhPublicEmployee_(updated);
  });
}

function rhPublicEmployee_(employee) {
  return {
    employee_id: employee.employee_id,
    full_name: employee.full_name,
    email: employee.email,
    role: employee.role,
    location_id: employee.location_id,
    is_active: employee.is_active,
    created_at: employee.created_at,
    updated_at: employee.updated_at
  };
}

function rhEmployeeLocationForRole_(ctx, role, locationId) {
  if (role === 'ADMIN') {
    if (locationId === undefined || locationId === null || locationId === '') return '';
    var adminLocation = rhRequireLocation_(ctx, locationId);
    if (adminLocation.is_active !== true) throw rhFail_('VALIDATION', 'locationId is not an active location');
    return adminLocation.location_id;
  }
  if (!locationId) throw rhFail_('VALIDATION', 'locationId is required for this role');
  var location = rhRequireLocation_(ctx, locationId);
  if (location.is_active !== true) throw rhFail_('VALIDATION', 'locationId is not an active location');
  return location.location_id;
}

function rhCountOtherActiveAdmins_(ctx, employeeId) {
  var records = rhReadSheet_(ctx, RH_SHEET.EMPLOYEES).records;
  var count = 0;
  for (var i = 0; i < records.length; i++) {
    if (records[i].employee_id === employeeId) continue;
    if (records[i].role === 'ADMIN' && records[i].is_active === true) count++;
  }
  return count;
}

function rhRequireSingle_(matches, missingMessage) {
  if (matches.length > 1) throw rhFail_('RECONCILIATION', 'Duplicate records found. Refusing to continue.');
  if (!matches.length) throw rhFail_('NOT_FOUND', missingMessage);
  return matches[0];
}
